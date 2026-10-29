export const MANUAL_TRANSFERS = true;
const profiles = {
  TRAINING: {area: 'TRAINING', titular: 'Dolores Navarro', alias: 'DUOCLUB', whatsappNumber: '5492494207343'},
  PERFORMANCE: {area: 'PERFORMANCE', titular: 'DAMIAN VILLAVERDE', alias: 'DUOCLUB.AR', whatsappNumber: '5491159421697'}
};
export function manualPaymentResponse(order) {
  let training = 0, performance = 0;
  for (const item of order.items || []) {
    const amount = Math.max(0, Number(item.price || 0)) * Math.max(1, Number(item.qty || 1));
    if (['RA', 'RF', 'SYN'].includes(item.serviceKey)) performance += amount;
    else if (item.serviceKey === 'EP') training += amount;
  }
  const transfer = profiles[performance > training ? 'PERFORMANCE' : 'TRAINING'];
  return {orderId: String(order._id), status: order.status, totalFinal: Number(order.totalFinal ?? order.total ?? 0), paymentChannel: order.paymentChannel || 'CASH', transfer};
}
