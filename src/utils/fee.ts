export function calculateMaxFee(amount: bigint, minimumFeeBps: number): bigint {
  const bpsTenths = Math.ceil(minimumFeeBps * 10);
  return (amount * BigInt(bpsTenths) + 99999n) / 100000n;
}
