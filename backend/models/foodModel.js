const mongoose = require("mongoose");

const foodSchema = new mongoose.Schema({

type:String,
donorName:String,
foodName:String,
quantity:String,
expiryTime:String,
location:String,
address:String,   
contact:String


});
const Food = mongoose.model("Food", foodSchema);

module.exports = Food;