/**
 * GET /api/health/ready (v0.29, S8): whether this cms reaches its database.
 * auth:false and no grant: monitors and the web's /healthz have no JWT,
 * and the answer says nothing beyond "ok" or "unavailable".
 */
export default {
  routes: [
    {
      method: "GET",
      path: "/health/ready",
      handler: "api::health.health.ready",
      config: { auth: false, policies: [] },
    },
  ],
};
