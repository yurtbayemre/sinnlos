/** Registered before the core :id route so /authoring is not treated as an id. */
const UID = "api::course.course";

export default {
  routes: [
    {
      method: "GET",
      path: "/courses/authoring",
      handler: "api::course.course.authoringList",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "authoringList" } }],
      },
    },
    {
      method: "GET",
      path: "/courses/:id/editable",
      handler: "api::course.course.editable",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "editable" } }],
      },
    },
    {
      method: "POST",
      path: "/courses/:id/publish",
      handler: "api::course.course.publish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "publish" } }],
      },
    },
    {
      method: "POST",
      path: "/courses/:id/unpublish",
      handler: "api::course.course.unpublish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "unpublish" } }],
      },
    },
    {
      method: "POST",
      path: "/courses/:id/discard-draft",
      handler: "api::course.course.discardDraft",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "discardDraft" } }],
      },
    },
  ],
};
