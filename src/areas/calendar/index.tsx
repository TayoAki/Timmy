import { CalendarDays } from 'lucide-react';
import { Placeholder, SideHead } from '../../components/kit';


export function CalendarView() {
  return <Placeholder title="Calendar" />;
}

export function CalendarSide() {
  return <SideHead icon={<CalendarDays size={18} />} title="Calendar" />;
}

export function CalendarContext() {
  return null;
}
