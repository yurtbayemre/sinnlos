import { RouteProgress } from "@/components/route-progress";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Dashboard-shaped skeleton: greeting, stat cards, news grid. */
export default function Loading() {
  return (
    <>
      <RouteProgress />
      <div className="space-y-8">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-64" />
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
