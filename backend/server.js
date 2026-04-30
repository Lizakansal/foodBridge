require("dotenv").config();
const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const cors = require("cors");
const nodemailer = require("nodemailer");
const twilio = require("twilio");
const path = require("path");

const app = express();
const Food = require("./models/foodModel.js");
const Reservation = require("./models/reservationModel");

app.use(express.json());
app.use(cors());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

mongoose.connect(process.env.MONGODB_URI)
.then(()=>console.log("MongoDB Atlas connected"))
.catch(err=>console.log(err));

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
// In a real production app, store this in Redis or MongoDB
const otps = {};

app.post("/send-otp-reserve", express.json(), async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone number required" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otps[phone] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

  try {
    await client.messages.create({
      body: `FoodBridge: Your NGO Verification OTP is ${otp}. Valid for 5 minutes.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: "+91" + phone
    });
    console.log(`✅ Sent OTP ${otp} to +91${phone}`);
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
    if (!otp || !otps[phone]) {
      return res.status(400).json({ error: "Please verify your OTP first." });
    }
    if (otps[phone].otp !== otp) {
      return res.status(400).json({ error: "Incorrect OTP entered." });
    }
    if (Date.now() > otps[phone].expiresAt) {
      delete otps[phone];
      return res.status(400).json({ error: "OTP expired. Please try again." });
    }

    // Success - clear OTP
    delete otps[phone];

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

    // 🔥 STEP 1: Send Email to DONOR
    try {
      // food.email = donor ka email (donate form se aaya tha)
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

      // ID ka photo attach karo agar upload hua ho
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

    // 🔥 STEP 2: Send SMS to DONOR
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
    let smsStatus = "An SMS has been sent to the requester.";
    if (reservation.phone) {
      try {
        await client.messages.create({
          body: `FoodBridge: Great news! Your food reservation has been ACCEPTED by the donor. Please coordinate for pickup.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: "+91" + reservation.phone
        });
        console.log("✅ Acceptance SMS sent to requester:", reservation.phone);
      } catch (smsErr) {
        console.log("❌ Requester SMS Error:", smsErr.message);
        smsStatus = `However, the SMS failed to send. Error: ${smsErr.message}`;
      }
    } else {
      smsStatus = "However, no phone number was found for this reservation, so SMS was not sent. It could be an old reservation request before the phone field was added.";
    }

    res.send(`<h1>✅ Reservation Accepted Successfully!</h1><p>${smsStatus}</p>`);
  } catch (err) {
    console.log(err);
    res.status(500).send("<h1>Server error</h1>");
  }
});

// 🔥 Reject Reservation Endpoint
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

    // Optionally send SMS for rejection too
    if (reservation.phone) {
      try {
        await client.messages.create({
          body: `FoodBridge: We're sorry, your food reservation was REJECTED by the donor.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: "+91" + reservation.phone
        });
      } catch (smsErr) {
        console.log("❌ Requester SMS Error:", smsErr.message);
      }
    }

    res.send("<h1>❌ Reservation Rejected</h1>");
  } catch (err) {
    console.log(err);
    res.status(500).send("<h1>Server error</h1>");
  }
});

app.listen(5000, () => {
  console.log("Server running on port 5000");
});