require("dotenv").config();
const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const cors = require("cors");
const nodemailer = require("nodemailer");
const twilio = require("twilio");
const path = require("path");
const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const Food = require("./models/foodModel.js");
const Reservation = require("./models/reservationModel");
const NgoOrder = require("./models/ngoOrderModel"); // NGO order history
const predictor = require("./ml/predictor"); // Import ML predictor

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "../frontend")));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB Atlas connected"))
  .catch(err => console.log(err));

// root route
app.get("/", (req, res) => {
  res.send("Server working");
});

// foods route
app.get("/foods", async (req, res) => {
  const foods = await Food.find({ status: { $ne: "donated" } });
  res.json(foods);
});

// donated-foods route
app.get("/donated-foods", async (req, res) => {
  const foods = await Food.find({ status: "donated" });
  res.json(foods);
});

// One-time migration: set status='available' on all old foods that have no status
app.get("/fix-old-foods", async (req, res) => {
  const result = await Food.updateMany(
    { status: { $exists: false } },
    { $set: { status: "available" } }
  );
  const result2 = await Food.updateMany(
    { status: null },
    { $set: { status: "available" } }
  );
  res.send(`Fixed ${result.modifiedCount + result2.modifiedCount} old food documents.`);
});

app.post("/add-food", async (req, res) => {
  console.log("POST /add-food hit");
  try {
    const foodData = req.body;
    foodData.status = "available"; // Set default status
    const food = new Food(foodData);
    await food.save();
    res.json({ message: "Food added successfully", food });
  } catch (error) {
    res.status(500).json({ error: "Error saving food" });
  }
});


app.post("/check-freshness", multer({ dest: "uploads/" }).single("foodImage"), async (req, res) => {
  console.log("POST /check-freshness hit! File:", req.file ? req.file.originalname : "NONE");
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const imagePath = req.file.path;

    const imageData = fs.readFileSync(imagePath).toString("base64");

    const prompt = `Analyze this food image for freshness and safety. 
    Provide a JSON response with the following fields:
    - status: "Fresh", "Slightly Stale", or "Spoiled"
    - confidence: percentage (e.g. 92)
    - description: a concise description of the food's condition
    - recommendation: MUST BE "Safe to donate" if status is "Fresh" or "Slightly Stale". MUST BE "Do not donate" if status is "Spoiled".
    Return ONLY a valid JSON object.`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: imageData,
          mimeType: req.file.mimetype
        }
      }
    ]);

    const response = await result.response;
    let text = response.text().trim();
    console.log("Gemini Raw Response:", text);

    text = text.replace(/```json|```/g, "");

    const analysis = JSON.parse(text);
    console.log("Parsed Analysis:", analysis);

    // Cleanup temporary file
    fs.unlink(imagePath, (err) => { if (err) console.error(err); });

    res.json(analysis);
  } catch (error) {
    console.error("Gemini Error:", error);
    res.status(500).json({ error: "Analysis failed", details: error.message });
  }
});


// storage config
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  }
});

const upload = multer({ storage: storage });

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Cache for storing temporary OTPs during reservation flow
const otps = {};

app.post("/send-otp-reserve", express.json(), async (req, res) => {
  const { email } = req.body;//ch
  if (!email) return res.status(400).json({ error: "Email required" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otps[email] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };// ch

  try {
    const mailOptions = {
      from: process.env.EMAIL_USER || "chhaviknsl@gmail.com",
      to: email,
      subject: "FoodBridge NGO Verification OTP",
      html: `<p>Your NGO Verification OTP is <b>${otp}</b>. Valid for 5 minutes.</p>`
    };
    await transporter.sendMail(mailOptions);
    console.log(`✅ Sent OTP ${otp} to ${email}`);// ch
    res.json({ message: "OTP sent" });
  } catch (err) {
    console.log("❌ OTP Error:", err.message);
    res.status(500).json({ error: "Failed to send OTP", details: err.message });
  }
});

// API
app.post("/reserve-food", upload.fields([
  { name: "idPhoto", maxCount: 1 }
]), async (req, res) => {

  try {
    console.log("Incoming request:", req.body);
    const { name, email, phone, idType, ngoId, quantity, foodId, otp } = req.body;

    // Check OTP
    if (!otp || !otps[email]) {
      return res.status(400).json({ error: "Please verify your OTP first." });
    }
    if (otps[email].otp !== otp) {
      return res.status(400).json({ error: "Incorrect OTP entered." });
    }
    if (Date.now() > otps[email].expiresAt) {
      delete otps[email];
      return res.status(400).json({ error: "OTP expired. Please try again." });
    }

    // Success - clear OTP
    delete otps[email];

    const idPhoto = req.files["idPhoto"]?.[0]?.filename;

    // MongoDB me save karo
    const newReservation = await Reservation.create({
      name,
      email,
      phone,
      idType,
      ngoId,
      quantity,
      foodId,
      idPhoto,
      status: "pending"
    });

    // Food details fetch karo (donor ki info ke liye)
    const food = await Food.findById(foodId);

    if (!food) {
      return res.status(404).json({ error: "Food not found" });
    }

    // Send Email to DONOR
    try {

      const recipient = food.email || "chhaviknsl@gmail.com";

      const mailOptions = {
        from: "chhaviknsl@gmail.com",
        to: recipient,
        subject: "New Food Reservation Request - FoodBridge",
        html: `
        <h2>New NGO Food Reservation Request!</h2>
        <p><b>NGO / Organization Name:</b> ${name}</p>
        <p><b>Email:</b> ${email}</p>
        <p><b>Phone:</b> ${phone}</p>
        <p><b>NGO Registration ID:</b> <strong>${ngoId || "Not provided"}</strong></p>
        <p><b>Quantity Requested:</b> ${quantity}</p>
        <br>
        <p>Please review the uploaded NGO ID proof and click one of the buttons below:</p>
        <a href="http://localhost:5000/accept-reservation/${newReservation._id}" style="padding: 10px 20px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px; margin-right: 10px;">✅ Accept Request</a>
        <a href="http://localhost:5000/reject-reservation/${newReservation._id}" style="padding: 10px 20px; background-color: #dc3545; color: white; text-decoration: none; border-radius: 5px;">❌ Reject Request</a>
        `,
        attachments: []
      };

      if (idPhoto) {
        mailOptions.attachments.push({
          filename: idPhoto,
          path: path.join(__dirname, "uploads", idPhoto)
        });
      }

      await transporter.sendMail(mailOptions);
      console.log("✅ Email sent to", recipient);
    } catch (emailErr) {
      console.log("❌ Email Error:", emailErr.message);
    }

    // Send SMS to DONOR
    try {
      console.log("Sending SMS to:", food.contact);
      await client.messages.create({
        body: `FoodBridge: New Food Request!\n\nName: ${name}\nQuantity: ${quantity}\n\nCheck your email to approve/reject.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: "+91" + food.contact
      });
      console.log("✅ SMS sent to", food.contact);
    } catch (smsErr) {
      console.log("❌ SMS Error:", smsErr.message);
    }

    // FINAL RESPONSE
    res.json({ message: "Reservation saved + Email and SMS sent" });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Server error" });
  }

});

// 🔥 Accept Reservation Endpoint
app.get("/accept-reservation/:id", async (req, res) => {
  try {
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) {
      return res.status(404).send("<h1>Reservation not found</h1>");
    }

    if (reservation.status !== "pending") {
      return res.send(`<h1>Reservation is already ${reservation.status}</h1>`);
    }

    reservation.status = "accepted";
    await reservation.save();

    // 🔥 FOOD QUANTITY DEDUCTION
    const food = await Food.findById(reservation.foodId);
    console.log("Food found:", food ? food.foodName : "NOT FOUND");
    console.log("Food quantity string:", food ? food.quantity : "N/A");
    console.log("Food current status:", food ? food.status : "N/A");
    console.log("Reservation quantity:", reservation.quantity);

    if (food) {
      const qtyString = String(food.quantity || "").trim();
      // Match number at the start (handles '20', '20 kg', '20 Servings' etc.)
      const qtyMatch = qtyString.match(/^([\d.]+)/);
      const reserveQty = parseFloat(reservation.quantity);

      if (qtyMatch && !isNaN(reserveQty)) {
        let currentQty = parseFloat(qtyMatch[1]);
        // Get the unit part (everything after the number and optional space)
        const unit = qtyString.replace(/^[\d.]+\s*/, "");
        currentQty -= reserveQty;
        console.log(`Qty after deduction: ${currentQty} ${unit}`);

        if (currentQty <= 0) {
          food.status = "donated";
          food.quantity = `0 ${unit}`.trim();
        } else {
          food.status = "available";
          food.quantity = `${currentQty} ${unit}`.trim();
        }
        await food.save();
        console.log("✅ Food updated, new status:", food.status, "new qty:", food.quantity);
      } else {
        console.log("❌ Could not parse quantity, marking as donated.");
        food.status = "donated";
        await food.save();
      }
    } else {
      console.log("❌ Food not found for foodId:", reservation.foodId);
    }

    // Send SMS to Requester
    // Send Email to Requester (NGO)
    let emailStatus = "An email notification has been sent to the requester.";
    if (reservation.email) {
      try {
        const mailOptions = {
          from: process.env.EMAIL_USER || "chhaviknsl@gmail.com",
          to: reservation.email,
          subject: "FoodBridge: Reservation Accepted",
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
              <h2 style="color: #28a745;">Reservation Accepted! ✅</h2>
              <p>Great news! Your food reservation has been <b>ACCEPTED</b> by the donor.</p>
              <p>Please coordinate with the donor for pickup.</p>
            </div>
          `
        };
        await transporter.sendMail(mailOptions);
        console.log("✅ Acceptance Email sent to requester:", reservation.email);
      } catch (emailErr) {
        console.log("❌ Requester Email Error:", emailErr.message);
        emailStatus = `However, the email failed to send. Error: ${emailErr.message}`;
      }
    } else {
      emailStatus = "However, no email address was found for this reservation.";
    }

    res.send(`
      <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px; padding: 20px; border: 1px solid #ddd; border-radius: 10px; max-width: 500px; margin-left: auto; margin-right: auto; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">
        <h1 style="color: #28a745;">✅ Request Accepted!</h1>
        <p style="color: #555;">You have successfully accepted the food request.</p>
        <p style="color: #888; font-size: 14px; margin-top: 20px;">${emailStatus}</p>
        <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Go to Homepage</a>
      </div>
    `);
  } catch (err) {
    console.log(err);
    res.status(500).send(`
      <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: #dc3545;">Server Error</h1>
        <p>Something went wrong. Please try again.</p>
      </div>
    `);
  }
});


// Reject Reservation Endpoint
app.get("/reject-reservation/:id", async (req, res) => {
  try {
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) {
      return res.status(404).send("<h1>Reservation not found</h1>");
    }

    if (reservation.status !== "pending") {
      return res.send(`<h1>Reservation is already ${reservation.status}</h1>`);
    }

    reservation.status = "rejected";
    await reservation.save();

    // Send Email for rejection
    let emailStatus = "An email notification has been sent to the requester.";
    if (reservation.email) {
      try {
        const mailOptions = {
          from: process.env.EMAIL_USER || "chhaviknsl@gmail.com",
          to: reservation.email,
          subject: "FoodBridge: Reservation Rejected",
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
              <h2 style="color: #dc3545;">Reservation Rejected ❌</h2>
              <p>We're sorry, your food reservation was <b>REJECTED</b> by the donor.</p>
              <p>You can browse other available food donations on our platform.</p>
            </div>
          `
        };
        await transporter.sendMail(mailOptions);
        console.log("✅ Rejection Email sent to requester:", reservation.email);
      } catch (emailErr) {
        console.log("❌ Requester Email Error:", emailErr.message);
        emailStatus = `However, the email failed to send. Error: ${emailErr.message}`;
      }
    } else {
      emailStatus = "However, no email address was found for this reservation.";
    }

    res.send(`
      <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px; padding: 20px; border: 1px solid #ddd; border-radius: 10px; max-width: 500px; margin-left: auto; margin-right: auto; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">
        <h1 style="color: #dc3545;">❌ Request Rejected</h1>
        <p style="color: #555;">You have rejected the food request.</p>
        <p style="color: #888; font-size: 14px; margin-top: 20px;">${emailStatus}</p>
        <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Go to Homepage</a>
      </div>
    `);
  } catch (err) {
    console.log(err);
    res.status(500).send(`
      <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: #dc3545;">Server Error</h1>
        <p>Something went wrong. Please try again.</p>
      </div>
    `);
  }
});


// 🔥 Predict Demand Endpoint (ML) - Simple fallback
app.post("/api/predict-demand", (req, res) => {
  try {
    const { peopleExpected, isWeekend, isHoliday } = req.body;

    if (peopleExpected === undefined) {
      return res.status(400).json({ error: "peopleExpected is required" });
    }

    const prediction = predictor.predictDemand({
      peopleExpected: Number(peopleExpected),
      isWeekend: Boolean(isWeekend),
      isHoliday: Boolean(isHoliday)
    });

    res.json({ predictedQuantity: prediction, unit: "kg" });
  } catch (err) {
    console.error("ML Prediction Error:", err);
    res.status(500).json({ error: "Failed to predict demand" });
  }
});

// 📋 Get all unique NGO names
app.get("/api/ngos", async (req, res) => {
  try {
    const ngos = await NgoOrder.distinct("ngoName");

    // Get summary stats for each NGO
    const ngoStats = await Promise.all(ngos.map(async (name) => {
      const stats = await NgoOrder.aggregate([
        { $match: { ngoName: name } },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            avgPlates: { $avg: "$platesOrdered" },
            totalPlates: { $sum: "$platesOrdered" },
            lastOrder: { $max: "$orderDate" }
          }
        }
      ]);
      return {
        name,
        totalOrders: stats[0]?.totalOrders || 0,
        avgPlates: Math.round(stats[0]?.avgPlates || 0),
        totalPlates: stats[0]?.totalPlates || 0,
        lastOrder: stats[0]?.lastOrder || null
      };
    }));

    res.json(ngoStats);
  } catch (err) {
    console.error("NGO List Error:", err);
    res.status(500).json({ error: "Failed to fetch NGOs" });
  }
});

// 📊 Get order history for a specific NGO
app.get("/api/ngo-orders/:ngoName", async (req, res) => {
  try {
    const { ngoName } = req.params;
    const orders = await NgoOrder.find({ ngoName }).sort({ orderDate: -1 }).limit(100);
    res.json(orders);
  } catch (err) {
    console.error("NGO Orders Error:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// 🧠 Smart Prediction - based on past NGO order data
app.post("/api/smart-predict", async (req, res) => {
  try {
    const { ngoName, targetDate } = req.body;

    if (!ngoName || !targetDate) {
      return res.status(400).json({ error: "ngoName and targetDate are required" });
    }

    // Fetch all past orders for this NGO
    const orders = await NgoOrder.find({ ngoName }).sort({ orderDate: 1 });

    if (orders.length === 0) {
      return res.status(404).json({ error: "No order history found for this NGO" });
    }

    const result = predictor.smartPredict(orders, targetDate);
    res.json(result);
  } catch (err) {
    console.error("Smart Prediction Error:", err);
    res.status(500).json({ error: "Failed to generate prediction" });
  }
});

// NGO Dashboard Routes
app.post("/ngo-send-otp", express.json(), async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otps[email] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

  try {
    const mailOptions = {
      from: process.env.EMAIL_USER || "chhaviknsl@gmail.com",
      to: email,
      subject: "FoodBridge NGO Dashboard OTP",
      html: `<p>Your OTP for logging into the NGO Dashboard is <b>${otp}</b>. It is valid for 5 minutes.</p>`
    };
    await transporter.sendMail(mailOptions);
    console.log(`✅ Sent Dashboard OTP ${otp} to ${email}`);
    res.json({ message: "OTP sent" });
  } catch (err) {
    console.log("❌ OTP Error:", err.message);
    res.status(500).json({ error: "Failed to send OTP", details: err.message });
  }
});

app.post("/ngo-verify-otp", express.json(), (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: "Email and OTP required" });

  if (!otps[email] || otps[email].otp !== otp) {
    return res.status(400).json({ error: "Invalid OTP" });
  }

  if (Date.now() > otps[email].expiresAt) {
    delete otps[email];
    return res.status(400).json({ error: "OTP expired" });
  }

  // Clear OTP on success
  delete otps[email];
  res.json({ message: "Login successful", email });
});

app.get("/ngo-accepted-requests/:email", async (req, res) => {
  try {
    const { email } = req.params;
    // Find accepted reservations for this email
    const reservations = await Reservation.find({ email: email, status: "accepted" });

    if (!reservations || reservations.length === 0) {
      return res.json([]);
    }

    // Fetch corresponding food data to get lat/lng
    const result = [];
    for (let r of reservations) {
      const food = await Food.findById(r.foodId);
      if (food) {
        result.push({
          reservationId: r._id,
          foodId: food._id,
          donorName: food.donorName,
          foodName: food.foodName,
          quantity: r.quantity, // Amount requested/accepted
          contact: food.contact,
          donorEmail: food.email,
          location: food.location,
          area: food.area,
          lat: food.lat,
          lng: food.lng
        });
      }
    }

    res.json(result);
  } catch (err) {
    console.error("Error fetching accepted requests:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 404 Handler
app.use((req, res) => {
  console.log(`404: ${req.method} ${req.url}`);
  res.status(404).send(`Route ${req.url} not found on this server.`);
});


app.listen(5000, () => {
  console.log("Server running on port 5000");
});