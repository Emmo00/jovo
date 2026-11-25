export function toUnits(value: string, decimals = 7): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("Invalid decimal places");
  }

  const [whole = "0", fraction = ""] = value.trim().split(".");
  if (
    !/^\d+$/.test(whole || "0") ||
    !/^\d*$/.test(fraction) ||
    fraction.length > decimals
  ) {
    throw new Error("Invalid amount");
  }

  return (
    BigInt(whole || "0") * BigInt(10) ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

export function fromUnits(value: bigint | string, decimals = 7): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("Invalid decimal places");
  }

  const units = BigInt(value);
  const zero = BigInt(0);
  const sign = units < zero ? "-" : "";
  const magnitude = units < zero ? -units : units;
  const base = BigInt(10) ** BigInt(decimals);
  const fraction = (magnitude % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  return fraction
    ? `${sign}${magnitude / base}.${fraction}`
    : `${sign}${magnitude / base}`;
}
