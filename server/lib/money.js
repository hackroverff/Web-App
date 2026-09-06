/** Money helpers. All prices are stored in rupees with 2-dp rounding. */
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const toInt = (n, fallback = 0) => {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? v : fallback;
};

/** Whole-rupee rounding used for delivery/grand totals so receipts look clean. */
export const roundRupee = (n) => Math.round(Number(n) || 0);

export function percentOff(mrp, price) {
  const m = Number(mrp) || 0;
  const p = Number(price) || 0;
  if (m <= 0 || p >= m) return 0;
  return Math.round(((m - p) / m) * 100);
}

export function inr(n, { decimals = 2 } = {}) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
