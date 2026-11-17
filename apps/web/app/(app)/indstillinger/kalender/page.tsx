import type { Metadata } from "next";
import { ClosedDaysEditor, OffShiftToggle, ShiftsEditor } from "@/components/settings/calendar-editor";
import { requireCapability } from "@/lib/auth";
import { getCalendar } from "@/lib/settings/calendar";
import { dayKey, formatLongDay, requestTime } from "@/lib/time";

export const metadata: Metadata = { title: "Kalender" };

export default async function CalendarPage() {
  const ctx = await requireCapability("/indstillinger/kalender", "times.edit");
  const calendar = await getCalendar(ctx.claims);
  const today = dayKey(requestTime());

  return (
    <div className="flex flex-col gap-6">
      <OffShiftToggle value={calendar.deductOffShift} />
      <ShiftsEditor shifts={calendar.shifts} />
      <ClosedDaysEditor
        days={calendar.closedDays.map((d) => ({
          day: d.day,
          name: d.name,
          label: formatLongDay(d.day),
          past: d.day < today,
        }))}
      />
    </div>
  );
}
