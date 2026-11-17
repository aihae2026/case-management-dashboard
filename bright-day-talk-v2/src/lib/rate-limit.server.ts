// 서버 전용: Upstash Redis로 요청 횟수를 제한한다.
// 환경변수가 없거나 Redis에 오류가 나면 제한하지 않고 통과시킨다.
// (제한 장치가 고장 났다고 어르신 서비스까지 멈추지 않게 하려는 선택이다)

async function getRedis() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const { Redis } = await import("@upstash/redis");
  return new Redis({ url, token });
}

// 일정 시간 안에 요청이 limit번을 넘으면 false. (성공이든 실패든 요청마다 센다)
export async function allowRequest(opts: {
  prefix: string;
  key: string;
  limit: number;
  window: `${number}${"s" | "m" | "h"}`;
}): Promise<boolean> {
  try {
    const redis = await getRedis();
    if (!redis) return true;
    const { Ratelimit } = await import("@upstash/ratelimit");
    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(opts.limit, opts.window),
      prefix: opts.prefix,
    });
    const { success } = await limiter.limit(opts.key);
    return success;
  } catch (err) {
    console.error(`[rate-limit] ${opts.prefix} 확인 실패, 통과시킴:`, err);
    return true;
  }
}

// "실패한 횟수"만 세는 잠금용 카운터. 맞게 입력했을 때는 세지 않고 지운다.
// 지금까지 실패 횟수 (확인하지 못하면 0)
export async function failureCount(key: string): Promise<number> {
  try {
    const redis = await getRedis();
    if (!redis) return 0;
    return Number((await redis.get<number>(key)) ?? 0);
  } catch (err) {
    console.error("[rate-limit] 실패 횟수 확인 실패, 통과시킴:", err);
    return 0;
  }
}

// 실패를 한 번 기록한다. 처음 기록할 때 ttlSeconds 뒤에 저절로 사라지게 한다.
export async function recordFailure(key: string, ttlSeconds: number): Promise<void> {
  try {
    const redis = await getRedis();
    if (!redis) return;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ttlSeconds);
  } catch (err) {
    console.error("[rate-limit] 실패 기록 실패:", err);
  }
}

export async function clearFailures(key: string): Promise<void> {
  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.del(key);
  } catch (err) {
    console.error("[rate-limit] 실패 기록 삭제 실패:", err);
  }
}
