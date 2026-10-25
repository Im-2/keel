import { useState } from "react"
import { useActivity } from "../lib/data"
import { Header } from "../ui/shell"
import { Button, Glass, MezoBadge, Skeleton, StateView } from "../ui/kit"
import { ActivityRow, explorerFor, useNewRows } from "../ui/activity"
import { shortError } from "../components"
import type { AppCtx } from "../App"
import { SplitsSection } from "./Split"

export function Activity({ ctx }: { ctx: AppCtx }) {
  const [limit, setLimit] = useState(30)
  const q = useActivity(limit)
  const fresh = useNewRows(q.data?.items)
  return (
    <>
      <Header title="Activity" greeting="History" />
      <SplitsSection />
      {q.isLoading ? (
        <Glass>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={48} style={{ margin: "10px 0" }} />)}</Glass>
      ) : q.error ? (
        <StateView kind="error" title="Couldn't load activity" body={shortError(q.error)} action={<Button variant="ghost" onClick={() => q.refetch()}>Try again</Button>} />
      ) : !q.data?.items.length ? (
        <StateView kind="empty" title="No activity yet" body="Loans, repayments, guardian protections and payments appear here." />
      ) : (
        <Glass className="activity">
          {q.data.items.map((it, i) => <ActivityRow key={it.id} item={it} explorer={explorerFor(ctx.cfg.network)} index={i} fresh={fresh.has(it.id)} />)}
          {q.data.more && <Button variant="quiet" busy={q.isFetching} onClick={() => setLimit((l) => l + 30)}>Show more</Button>}
        </Glass>
      )}
      <footer className="foot"><MezoBadge /></footer>
    </>
  )
}
