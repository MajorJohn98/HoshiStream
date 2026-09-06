declare module "bencode" {
  const bencode: {
    decode(data: Uint8Array): unknown;
    encode(data: unknown): Uint8Array;
  };
  export default bencode;
}
