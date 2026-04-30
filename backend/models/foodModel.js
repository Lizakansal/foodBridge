const mongoose = require("mongoose");

const foodSchema = new mongoose.Schema({

type:String,
donorName:String,
foodName:String,
quantity:String,
expiryTime:String,
area:String,
location:String,  
contact:String,
email:String,
lat: String,
lng: String

});
const Food = mongoose.model("Food", foodSchema);

module.exports = Food;