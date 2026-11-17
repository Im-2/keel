import { createRoot } from "react-dom/client"
import { Status } from "./Status"

// Own tiny entry: the status page needs no wallet code and must not wait for the Telegram script.
const el = document.getElementById("root")!
el.replaceChildren()
createRoot(el).render(<Status />)
