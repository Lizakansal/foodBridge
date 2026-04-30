const mongoose = require("mongoose");

const reservationSchema = new mongoose.Schema({
  name: String,
  email: String,
  idType: String,
  quantity: Number,
  foodId: String,
  idPhoto: String,
  status: String
});

const Reservation = mongoose.model("Reservation", reservationSchema);

module.exports = Reservation;
