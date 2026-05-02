require('dotenv').config();
const mongoose = require('mongoose');
const Food = require('./models/foodModel.js');

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    const availableFoods = await Food.find({ status: { $ne: "donated" } });
    console.log(JSON.stringify(availableFoods, null, 2));
    process.exit();
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });