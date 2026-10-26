/**
 * The longest kudos message (#198), in UTF-16 code units like the
 * textarea's `maxLength`: the cms refuses a longer one (400, `details.code`
 * `message`) instead of cutting it, the web's textarea stops at it. A kudos
 * is a short thank-you; the feed, the digest and the notifications carry it.
 */
export const MAX_KUDOS_MESSAGE = 1000;
