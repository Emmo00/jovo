export function friendly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Error\(Contract, #4\)/.test(message)) {
    return "This link was already claimed or refunded.";
  }
  if (/Error\(Contract, #5\)/.test(message)) {
    return "This link can’t be refunded yet.";
  }
  if (/trustline/i.test(message)) {
    return "That wallet can’t receive this token yet. Add a trustline for it, or let us create a wallet for you.";
  }
  if (/balance|insufficient/i.test(message)) {
    return "Not enough balance for that amount.";
  }
  if (/user declined|rejected/i.test(message)) {
    return "The request was cancelled.";
  }
  return "Something went wrong. Please try again.";
}
