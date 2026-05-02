/**
 * Seed Script: Populate 10 NGOs with realistic past order history
 * Run: node seedNgoData.js
 */
require("dotenv").config({ path: "./backend/.env" });
const mongoose = require("mongoose");
const NgoOrder = require("./models/ngoOrderModel");

// 10 NGO names
const ngos = [
  "Akshaya Patra Foundation",
  "Robin Hood Army",
  "Feeding India",
  "Goonj",
  "Annamrita Foundation",
  "No Food Waste",
  "Roti Bank",
  "Seva Kitchen",
  "Meal for All",
  "Food for Life"
];

const areas = ["Connaught Place", "Saket", "Lajpat Nagar", "Dwarka", "Rohini", "Karol Bagh", "Nehru Place", "Janakpuri", "Pitampura", "Vasant Kunj"];

// Indian holidays / festivals in our date range
const holidays = [
  "2026-01-26", // Republic Day
  "2026-03-14", // Holi
  "2026-03-30", // Eid-ul-Fitr (approx)
  "2026-04-14", // Baisakhi / Ambedkar Jayanti
  "2026-04-02", // Ram Navami
];

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function isHoliday(dateStr) {
  return holidays.includes(dateStr);
}

function generateOrdersForNgo(ngoName, areaIndex) {
  const orders = [];
  const startDate = new Date("2026-01-01");
  const endDate = new Date("2026-04-30");

  // Base demand varies per NGO (some are bigger than others)
  const basePlates = 50 + Math.floor(Math.random() * 150); // 50-200 base plates

  let current = new Date(startDate);
  while (current <= endDate) {
    const dateStr = current.toISOString().split("T")[0];
    const dayOfWeek = current.getDay();

    // NGOs don't order every day — simulate realistic frequency
    // Bigger NGOs order more frequently
    const orderProbability = basePlates > 150 ? 0.85 : basePlates > 100 ? 0.65 : 0.45;

    if (Math.random() < orderProbability) {
      let plates = basePlates;
      let eventType = "regular";

      // Weekend boost (15-30% more)
      if (isWeekend(current)) {
        plates = Math.round(plates * (1.15 + Math.random() * 0.15));
        eventType = "weekend";
      }

      // Holiday boost (40-70% more)
      if (isHoliday(dateStr)) {
        plates = Math.round(plates * (1.4 + Math.random() * 0.3));
        eventType = "holiday";
      }

      // Monthly growth trend (NGOs grow over time, ~2-5% per month)
      const monthsElapsed = (current.getMonth() - startDate.getMonth()) + 
        (current.getFullYear() - startDate.getFullYear()) * 12;
      plates = Math.round(plates * (1 + monthsElapsed * (0.02 + Math.random() * 0.03)));

      // Random daily variance (+/- 15%)
      plates = Math.round(plates * (0.85 + Math.random() * 0.30));

      // Minimum 10 plates
      plates = Math.max(10, plates);

      orders.push({
        ngoName,
        orderDate: new Date(current),
        platesOrdered: plates,
        eventType,
        area: areas[areaIndex % areas.length]
      });
    }

    current.setDate(current.getDate() + 1);
  }

  return orders;
}

async function seedData() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB connected");

    // Clear existing NGO order data
    await NgoOrder.deleteMany({});
    console.log("🗑️  Cleared old NGO order data");

    let totalOrders = 0;

    for (let i = 0; i < ngos.length; i++) {
      const orders = generateOrdersForNgo(ngos[i], i);
      await NgoOrder.insertMany(orders);
      totalOrders += orders.length;
      console.log(`📦 ${ngos[i]}: ${orders.length} orders seeded`);
    }

    console.log(`\n🎉 Total ${totalOrders} orders seeded for ${ngos.length} NGOs!`);

    // Print sample data summary
    console.log("\n📊 Sample data summary:");
    for (const ngo of ngos) {
      const count = await NgoOrder.countDocuments({ ngoName: ngo });
      const avgPlates = await NgoOrder.aggregate([
        { $match: { ngoName: ngo } },
        { $group: { _id: null, avg: { $avg: "$platesOrdered" } } }
      ]);
      console.log(`   ${ngo}: ${count} orders, avg ${Math.round(avgPlates[0]?.avg || 0)} plates/order`);
    }

    await mongoose.disconnect();
    console.log("\n✅ Done! MongoDB disconnected.");
  } catch (err) {
    console.error("❌ Seed error:", err);
    process.exit(1);
  }
}

seedData();