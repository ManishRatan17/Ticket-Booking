// Money is stored as whole paise (₹499.00 = 49900): never floating-point rupees.
export function formatRupees(paise) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
