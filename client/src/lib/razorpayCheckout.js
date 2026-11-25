// Razorpay's checkout window (Phase 7). Loads Razorpay's script once, opens the window, and resolves
// with Razorpay's answer when the person has paid:
//   { razorpay_payment_id, razorpay_order_id, razorpay_signature }
// (our server checks that signature; this page proves nothing on its own).
// Resolves null if the person closes the window without paying. Card details never touch our pages.
const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js'
let loading = null

function loadRazorpay() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.onload = () => resolve(window.Razorpay)
    script.onerror = () => {
      loading = null
      reject(new Error("Razorpay's checkout could not load. Check your connection."))
    }
    document.head.appendChild(script)
  })
  return loading
}

// details = what our server's "start" answered: { keyId, razorpayOrderId, amountPaise, currency, description }
export async function openRazorpayCheckout(details, { email, onAttemptFailed } = {}) {
  const Razorpay = await loadRazorpay()
  return new Promise((resolve) => {
    const checkout = new Razorpay({
      key: details.keyId,
      order_id: details.razorpayOrderId,
      amount: details.amountPaise,
      currency: details.currency,
      name: 'Flash-Sale Tickets',
      description: details.description,
      prefill: email ? { email } : undefined,
      handler: (answer) => resolve(answer),
      modal: { ondismiss: () => resolve(null) },
    })
    // A declined card: the window stays open so the person can try again.
    checkout.on('payment.failed', (event) => onAttemptFailed?.(event?.error?.description))
    checkout.open()
  })
}
