require('dotenv').config();
const mongoose = require('mongoose');
const Food = require('./models/foodModel.js');

mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        try {
            const foodData = {
                type: "Veg",
                donorName: "Test",
                foodName: "TestFood",
                quantity: "1 Packets",
                expiryTime: "2026-05-02T00:00",
                area: "TestArea",
                location: "TestLoc",
                contact: "1234567890",
                email: "test@test.com",
                status: "available",
            };
            const food = new Food(foodData);
            await food.save();
            console.log("SUCCESSFULLY SAVED:", food);
        } catch (err) {
            console.log("ERROR SAVING:", err);
        }
        process.exit();
    })
    .catch(err => {
        console.error(err);
        process.exit(1);
    });