import { Panel, PanelBody, Skeleton, SkeletonGroup } from '@/components/ui'
import { PageBody } from '@/components/patterns/page-header'

/**
 * The dashboard's loading state. Skeletons in the shape of the real content, not a
 * centred spinner — the page's structure is known before its data is, and showing it
 * makes the wait feel shorter and stops the layout jumping when data arrives.
 *
 * `SkeletonGroup` owns the aria-busy/live wiring and the label, so a screen-reader user
 * is told the page is loading rather than hearing nothing.
 */
export default function DashboardLoading() {
  return (
    <>
      <div className="gutter-x mx-auto w-full max-w-[1280px] pt-8 pb-5 md:pt-10 md:pb-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="mt-3 h-5 w-full max-w-lg" />
      </div>

      <PageBody>
        <SkeletonGroup label="Loading dashboard">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Panel key={i}>
                <PanelBody>
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="mt-4 h-9 w-16" />
                  <Skeleton className="mt-2 h-3 w-32" />
                </PanelBody>
              </Panel>
            ))}
          </div>

          {[0, 1, 2].map((i) => (
            <div key={i} className="mt-10">
              <Skeleton className="h-5 w-40" />
              <Panel className="mt-4">
                <PanelBody className="space-y-3">
                  {[0, 1, 2].map((row) => (
                    <Skeleton key={row} className="h-10 w-full" />
                  ))}
                </PanelBody>
              </Panel>
            </div>
          ))}
        </SkeletonGroup>
      </PageBody>
    </>
  )
}
