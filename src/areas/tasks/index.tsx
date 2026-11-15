import { ListChecks } from 'lucide-react';
import { Placeholder, SideHead } from '../../components/kit';


export function TasksView() {
  return <Placeholder title="Tasks" />;
}

export function TasksSide() {
  return <SideHead icon={<ListChecks size={18} />} title="Tasks" />;
}

export function TasksContext() {
  return null;
}
