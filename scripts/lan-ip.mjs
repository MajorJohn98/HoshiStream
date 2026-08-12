import { networkInterfaces } from "node:os";

export function lanIp(interfaces = networkInterfaces()) {
  const addresses = Object.entries(interfaces)
    .flatMap(([name, values]) =>
      (values ?? []).map((address) => ({ name, ...address })),
    )
    .filter(
      (address) =>
        address.family === "IPv4" &&
        !address.internal &&
        /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address.address),
    );
  return (
    addresses.find((address) => address.name === "en0")?.address ??
    addresses[0]?.address ??
    null
  );
}
