import { RouteProgress } from "@/components/route-progress";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Content-shaped loading layouts shared by the route-level loading.tsx
 * files. Each mirrors the real page closely enough that the swap from
 * skeleton to content doesn't shift the layout.
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
