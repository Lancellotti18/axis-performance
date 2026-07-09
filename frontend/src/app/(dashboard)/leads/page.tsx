import { redirect } from 'next/navigation'

/** Leads merged into the CRM pipeline — one home for every lead.
 *  RoofIQ tools + funnel live at the top of /crm; widget leads auto-import
 *  into the kanban. This route stays as a redirect so old links/bookmarks work. */
export default function LeadsRedirect() {
  redirect('/crm')
}
