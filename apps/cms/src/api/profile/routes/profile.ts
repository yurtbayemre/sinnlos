export default {
  routes: [
    {
      method: "GET",
      path: "/me",
      handler: "api::profile.profile.me",
      config: { policies: [] },
    },
    {
      method: "PUT",
      path: "/me",
      handler: "api::profile.profile.updateMe",
      config: { policies: [] },
    },
    // v0.27: the second factor of the caller's own local account (utils/mfa.ts).
    {
      method: "POST",
      path: "/me/mfa/setup",
      handler: "api::profile.profile.mfaSetup",
      config: { policies: [] },
    },
    {
      method: "POST",
      path: "/me/mfa/activate",
      handler: "api::profile.profile.mfaActivate",
      config: { policies: [] },
    },
    {
      method: "POST",
      path: "/me/mfa/disable",
      handler: "api::profile.profile.mfaDisable",
      config: { policies: [] },
    },
  ],
};
