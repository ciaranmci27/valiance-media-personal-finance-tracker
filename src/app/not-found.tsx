import { redirect } from "next/navigation";

/**
 * Any page address the app does not have goes home (and from there to login
 * when signed out), the same place `/` goes. Unknown API addresses never reach
 * this: `api/[...unknown]` answers them with a JSON 404.
 */
export default function NotFound() {
  redirect("/");
}
