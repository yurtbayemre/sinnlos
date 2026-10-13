import type { ReactNode } from "react";
import { CalendarDays, ExternalLink, MapPin } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type {
  AnnouncementEditable,
  EventEditable,
  PollEditable,
  QuickLinkEditable,
} from "@sinnlos/domain";
import { AnnouncementCard } from "@/components/announcements/announcement-card";
import { ICONS, isIconName } from "@/components/icon-map";
import { Markdown } from "@/components/markdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatInstant, LONG_DAY } from "@/lib/date-format";
import { eventTimeLabel } from "@/lib/event-dates";

/**
 * The previews of /manage (deep-dive decision 06 §L4): the saved draft as
 * readers will see it, built from the `editable` answer only (never from a
 * generic `?status=draft` read, which department authors do not have),
 * with the readers' components where the pages have one (the announcement
 * card, the Markdown renderer, the icon map). Server components.
 */

export function PreviewSection({ children }: { children: ReactNode }) {
  const t = useTranslations("manage.common.preview");
  return (
    <section aria-labelledby="manage-preview" className="space-y-3">
      <div>
        <h2 id="manage-preview" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <div className="rounded-2xl border border-dashed p-3 sm:p-4">{children}</div>
    </section>
  );
}

export function AnnouncementPreview({ editable }: { editable: AnnouncementEditable }) {
  const t = useTranslations("manage.common.preview");
  const format = useFormatter();
  return (
    <AnnouncementCard
      variant="full"
      highlighted={editable.pinned === true}
      item={{
        id: 0,
        documentId: editable.documentId,
        title: editable.title,
        body: editable.body ?? undefined,
        pinned: editable.pinned,
        requiresAck: editable.requiresAck,
        ackDeadline: editable.ackDeadline ?? null,
        author: null,
      }}
      dateLabel={formatInstant(format, editable.publishedAt ?? editable.updatedAt, LONG_DAY)}
      unknownLabel={t("unknownAuthor")}
    />
  );
}

export function EventPreview({
  editable,
  timeZone,
}: {
  editable: EventEditable;
  timeZone: string;
}) {
  const format = useFormatter();
  const when = eventTimeLabel(editable, format, timeZone);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{editable.title}</CardTitle>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {when && (
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-4 w-4" aria-hidden="true" />
              {when}
            </span>
          )}
          {editable.location && (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="h-4 w-4" aria-hidden="true" />
              {editable.location}
            </span>
          )}
        </div>
      </CardHeader>
      {editable.description ? (
        <CardContent>
          <Markdown className="prose prose-sm prose-slate max-w-none text-muted-foreground dark:prose-invert">
            {editable.description}
          </Markdown>
        </CardContent>
      ) : null}
    </Card>
  );
}

export function QuickLinkPreview({ editable }: { editable: QuickLinkEditable }) {
  const Icon = isIconName(editable.icon) ? ICONS[editable.icon] : ExternalLink;
  return (
    <Card className="max-w-sm">
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium">{editable.label}</div>
          <div className="truncate text-xs text-muted-foreground">{editable.url}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function PollPreview({ editable }: { editable: PollEditable }) {
  const t = useTranslations("manage.polls.state");
  const format = useFormatter();
  const closes = formatInstant(format, editable.closesAt, LONG_DAY);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{editable.question}</CardTitle>
        {closes && (
          <p className="text-sm text-muted-foreground">{t("closesOn", { date: closes })}</p>
        )}
      </CardHeader>
      <CardContent>
        <ol className="space-y-2">
          {editable.options.map((option, i) => (
            <li key={i} className="rounded-xl border px-3 py-2 text-sm">
              {option}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
