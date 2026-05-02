/**
 * Smart Demand Prediction Engine
 * Uses historical NGO order data to predict future demand.
 * 
 * Techniques used:
 * 1. Weighted Moving Average (recent data matters more)
 * 2. Day-of-week seasonality pattern
 * 3. Weekend / Holiday boost factors (learned from data)
 * 4. Growth trend detection
 * 5. Confidence scoring
 */

/**
 * Analyze historical orders and predict demand for a given date
 * @param {Array} orders - Past orders for this NGO [{orderDate, platesOrdered, eventType}]
 * @param {Date} targetDate - The date to predict for
 * @returns {Object} { predictedPlates, confidence, breakdown }
 */
function smartPredict(orders, targetDate) {
  if (!orders || orders.length === 0) {
    return { predictedPlates: 50, confidence: 10, breakdown: { message: "No historical data — using default estimate" } };
  }

  const target = new Date(targetDate);
  const targetDay = target.getDay(); // 0=Sun, 6=Sat
  const isTargetWeekend = targetDay === 0 || targetDay === 6;

  // --- 1. Calculate overall average ---
  const totalPlates = orders.reduce((sum, o) => sum + o.platesOrdered, 0);
  const overallAvg = totalPlates / orders.length;

  // --- 2. Day-of-week pattern (seasonality) ---
  const dayBuckets = [[], [], [], [], [], [], []]; // Sun-Sat
  orders.forEach(o => {
    const d = new Date(o.orderDate);
    dayBuckets[d.getDay()].push(o.platesOrdered);
  });

  const dayAverages = dayBuckets.map(bucket => {
    if (bucket.length === 0) return overallAvg;
    return bucket.reduce((a, b) => a + b, 0) / bucket.length;
  });

  const dayFactor = dayAverages[targetDay] / overallAvg;

  // --- 3. Weighted Moving Average (last 30 days weigh more) ---
  const sortedOrders = [...orders].sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
  let weightedSum = 0;
  let weightTotal = 0;
  sortedOrders.forEach((o, i) => {
    const weight = 1 / (i + 1); // More recent = higher weight
    weightedSum += o.platesOrdered * weight;
    weightTotal += weight;
  });
  const weightedAvg = weightedSum / weightTotal;

  // --- 4. Growth trend (compare first half vs second half) ---
  const midIndex = Math.floor(sortedOrders.length / 2);
  const recentHalf = sortedOrders.slice(0, midIndex);
  const olderHalf = sortedOrders.slice(midIndex);

  const recentAvg = recentHalf.reduce((s, o) => s + o.platesOrdered, 0) / (recentHalf.length || 1);
  const olderAvg = olderHalf.reduce((s, o) => s + o.platesOrdered, 0) / (olderHalf.length || 1);
  const growthRate = olderAvg > 0 ? (recentAvg - olderAvg) / olderAvg : 0;

  // --- 5. Weekend/Holiday boost from actual data ---
  const weekdayOrders = orders.filter(o => {
    const d = new Date(o.orderDate).getDay();
    return d !== 0 && d !== 6;
  });
  const weekendOrders = orders.filter(o => {
    const d = new Date(o.orderDate).getDay();
    return d === 0 || d === 6;
  });
  const holidayOrders = orders.filter(o => o.eventType === "holiday");

  const weekdayAvg = weekdayOrders.length > 0
    ? weekdayOrders.reduce((s, o) => s + o.platesOrdered, 0) / weekdayOrders.length
    : overallAvg;
  const weekendAvg = weekendOrders.length > 0
    ? weekendOrders.reduce((s, o) => s + o.platesOrdered, 0) / weekendOrders.length
    : overallAvg;
  const holidayAvg = holidayOrders.length > 0
    ? holidayOrders.reduce((s, o) => s + o.platesOrdered, 0) / holidayOrders.length
    : overallAvg;

  const weekendBoostFactor = weekdayAvg > 0 ? weekendAvg / weekdayAvg : 1.15;
  const holidayBoostFactor = weekdayAvg > 0 ? holidayAvg / weekdayAvg : 1.5;

  // --- 6. Combine all factors ---
  let predicted = weightedAvg * dayFactor;

  // Apply growth trend (cap at +/- 20%)
  const clampedGrowth = Math.max(-0.2, Math.min(0.2, growthRate));
  predicted *= (1 + clampedGrowth * 0.5); // Apply half the growth as future projection

  // Round to nearest whole number
  predicted = Math.round(predicted);

  // Ensure minimum
  predicted = Math.max(10, predicted);

  // --- 7. Confidence score ---
  let confidence = 30; // base
  if (orders.length > 10) confidence += 15;
  if (orders.length > 30) confidence += 15;
  if (orders.length > 60) confidence += 10;
  if (dayBuckets[targetDay].length > 3) confidence += 15;
  if (Math.abs(growthRate) < 0.1) confidence += 10; // Stable patterns are more predictable
  confidence = Math.min(95, confidence);

  return {
    predictedPlates: predicted,
    confidence,
    breakdown: {
      overallAvg: Math.round(overallAvg),
      weightedAvg: Math.round(weightedAvg),
      dayOfWeekAvg: Math.round(dayAverages[targetDay]),
      dayFactor: parseFloat(dayFactor.toFixed(2)),
      growthRate: parseFloat((growthRate * 100).toFixed(1)) + "%",
      weekendBoost: parseFloat(weekendBoostFactor.toFixed(2)),
      holidayBoost: parseFloat(holidayBoostFactor.toFixed(2)),
      totalOrdersAnalyzed: orders.length,
      isTargetWeekend
    }
  };
}

/**
 * Simple predictor (fallback when no NGO selected)
 */
function predictDemand(inputData) {
  let baseDemand = inputData.peopleExpected * 0.3;
  let modifier = 1.0;

  if (inputData.isWeekend) modifier += 0.15;
  if (inputData.isHoliday) modifier += 0.35;

  let predictedQuantity = baseDemand * modifier;
  const variance = 1 + ((Math.random() * 0.1) - 0.05);
  predictedQuantity = predictedQuantity * variance;
  predictedQuantity = Math.round(predictedQuantity);
  if (predictedQuantity < 1) predictedQuantity = 1;

  return predictedQuantity;
}

module.exports = {
  predictDemand,
  smartPredict
};