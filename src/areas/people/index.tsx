import { Users } from 'lucide-react';
import { Placeholder, SideHead } from '../../components/kit';


export function PeopleView() {
  return <Placeholder title="People" />;
}

export function ContactView() {
  return <Placeholder title="Contact" />;
}

export function PeopleSide() {
  return <SideHead icon={<Users size={18} />} title="People" />;
}

export function PeopleContext() {
  return null;
}
