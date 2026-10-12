import { RouteProgress } from "@/components/route-progress";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Content-shaped loading layouts shared by the route-level loading.tsx
 * files (UI05): every page under app/(app) has a loading.tsx that renders
 * or re-exports one of these (pinned by app/(app)/loading-files.test.ts).
 * Each page-level skeleton starts with RouteProgress, mirrors the real page
 * closely enough that the swap from skeleton to content doesn't shift the
 * layout, and uses no fixed width wider than a phone (w-80 and up take
 * max-w-full).
 */

export function HeaderSkeleton({ withEyebrow = false }: { withEyebrow?: boolean }) {
  return (
    <div className="space-y-2">
      {withEyebrow && <Skeleton className="h-4 w-24" />}
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-5 w-80 max-w-full" />
    </div>
  );
}

export function CardGridSkeleton({
  count = 6,
  columns = "sm:grid-cols-2 lg:grid-cols-3",
  withBanner = false,
}: {
  count?: number;
  columns?: string;
  withBanner?: boolean;
}) {
  return (
    <div className={`grid gap-4 ${columns}`}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            {withBanner && <Skeleton className="mb-3 h-20 w-full" />}
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-full" />
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

export function ListPageSkeleton({
  withBanner = false,
  count = 6,
}: {
  withBanner?: boolean;
  count?: number;
}) {
  return (
    <>
      <RouteProgress />
      <div className="space-y-6">
        <HeaderSkeleton />
        <CardGridSkeleton count={count} withBanner={withBanner} />
      </div>
    </>
  );
}

export function DetailPageSkeleton({ withHero = false }: { withHero?: boolean }) {
  return (
    <>
      <RouteProgress />
      <div className="space-y-8">
        {withHero && <Skeleton className="h-40 w-full rounded-2xl" />}
        <HeaderSkeleton withEyebrow />
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-40" />
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-16" />
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

export function ArticleSkeleton() {
  return (
    <>
      <RouteProgress />
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-3 border-b pb-6">
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-3 w-64" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-4"
              style={{ width: `${[100, 92, 96, 60, 98, 88, 45][i]}%` }}
            />
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * The dashboard (the (app) root): greeting, stat cards, the news grid.
 */
export function DashboardSkeleton() {
  return (
    <>
      <RouteProgress />
      <div className="space-y-8">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40 max-w-full" />
          <Skeleton className="h-9 w-64 max-w-full" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="flex items-center gap-4 p-6">
                <Skeleton className="h-11 w-11 rounded-xl" />
                <div className="space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-7 w-12" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="space-y-4">
          <Skeleton className="h-6 w-32" />
          <div className="grid gap-4 lg:grid-cols-5">
            <Skeleton className="h-64 rounded-lg lg:col-span-3" />
            <div className="flex flex-col gap-3 lg:col-span-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[76px] rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** /training: the course cards, two per row. */
export function CourseListSkeleton() {
  return (
    <>
      <RouteProgress />
      <div className="space-y-8">
        <HeaderSkeleton withEyebrow />
        <CardGridSkeleton count={4} columns="md:grid-cols-2" />
      </div>
    </>
  );
}

/** A list of rows in one card: the lessons of a course. */
function RowListSkeleton({ rows }: { rows: number }) {
  return (
    <Card>
      <CardContent className="divide-y p-0">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
            <Skeleton className="h-4" style={{ width: `${[70, 55, 80, 62, 48][i % 5]}%` }} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** /training/[slug]: back link, title, progress and the lesson list. */
export function CourseSkeleton() {
  return (
    <>
      <RouteProgress />
      <div className="space-y-8">
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-72 max-w-full" />
          <Skeleton className="h-5 w-80 max-w-full" />
          <Skeleton className="h-8 w-36" />
        </div>
        <RowListSkeleton rows={5} />
      </div>
    </>
  );
}

/** /training/[slug]/[lessonId]: back link, title, the video and the text. */
export function LessonSkeleton() {
  return (
    <>
      <RouteProgress />
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32 max-w-full" />
          <Skeleton className="h-9 w-3/4" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="aspect-video w-full rounded-xl" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4" style={{ width: `${[100, 94, 88, 97, 52][i]}%` }} />
          ))}
        </div>
      </div>
    </>
  );
}

/** /manage: the header and the tile sections. */
export function ManageSkeleton() {
  return (
    <>
      <RouteProgress />
      <div className="space-y-8">
        <HeaderSkeleton withEyebrow />
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <Skeleton className="h-6 w-40 max-w-full" />
            <CardGridSkeleton count={4} columns="sm:grid-cols-2" />
          </div>
        ))}
      </div>
    </>
  );
}

/** A form page (/polls/new): header, the fields in a card, the submit button. */
export function FormPageSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <>
      <RouteProgress />
      <div className="space-y-8">
        <HeaderSkeleton />
        <Card>
          <CardContent className="space-y-5 p-6">
            {Array.from({ length: fields }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-10 w-full rounded-xl" />
              </div>
            ))}
            <Skeleton className="h-10 w-36 rounded-xl" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
