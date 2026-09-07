import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";

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
    addresses.find((address) =>
      /^(wi-?fi|ethernet)(\s+\d+)?$/i.test(address.name),
    )?.address ??
    addresses.find(
      (address) =>
        !/^(vEthernet|VirtualBox|VMware|docker|tailscale|utun|tun\d|tap\d)/i.test(
          address.name,
        ),
    )?.address ??
    addresses[0]?.address ??
    null
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify({ address: lanIp() }));
