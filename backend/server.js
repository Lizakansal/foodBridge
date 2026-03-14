const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const Food = require("./models/foodModel.js");
console.log("Food model:", Food);
const app = express();

app.use(express.json());
app.use(cors());

// MongoDB connection
mongoose.connect("mongodb+srv://foodbridge:Foodbridge123@cluster0.flrhrn9.mongodb.net/foodbridge")
.then(()=>console.log("MongoDB Atlas connected"))
.catch(err=>console.log(err));

// root route
app.get("/", (req, res) => {
  res.send("Server working");
});

// foods route
app.get("/foods", async (req, res) => {
  const foods = await Food.find();
  res.json(foods);
});

app.post("/add-food", async (req, res) => {

  console.log("POST /add-food hit");
  try {
    const food = new Food(req.body);
    await food.save();
    res.json({ message: "Food added successfully", food });
  } catch (error) {
    res.status(500).json({ error: "Error saving food" });
  }
});

// start server
app.listen(5000, () => {
  console.log("Server started on port 5000");
});