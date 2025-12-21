import crypto from "crypto";

/**
 * chapId: number (0–255)
 * chapChallenge: number[]  // ví dụ [143,125,31,361,...] -> nhớ clamp 0–255
 * password: string
 */
export function chapMD5(chapId: number, chapChallenge: number[], password: string) {
  const idBuf = Buffer.from([chapId & 0xff]);
  const pwdBuf = Buffer.from(password, "utf8");
  const chalBuf = Buffer.from(chapChallenge.map(x => x & 0xff));
  return crypto
    .createHash("md5")
    .update(Buffer.concat([idBuf, pwdBuf, chalBuf]))
    .digest("hex");
}
