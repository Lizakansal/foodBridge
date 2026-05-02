const mongoose = require("mongoose");

const ngoOrderSchema = new mongoose.Schema({
    ngoName: { type: String, required: true },
    orderDate: { type: Date, required: true },
    platesOrdered: { type: Number, required: true },
    eventType: { type: String, default: "regular" }, // regular, weekend, holiday, festival
    area: { type: String },
    createdAt: { type: Date, default: Date.now }
});

const NgoOrder = mongoose.model("NgoOrder", ngoOrderSchema);

module.exports = NgoOrder;