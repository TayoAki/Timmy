/**
 * Triage: a sorting rule Timmy proposes from how the person filed mail themselves ("You moved 2 emails from anyone
 * at medium.com to the archive yourself"). One at a time, with the rule in words; it is saved only when they say so.
 * The same offers are in Library › Learned rules.
 */
import { Sparkles } from 'lucide-react';
import { acceptLearned, declineLearned } from '../state/learned';
import { useProfile } from '../live/LiveApp';
import { useStore } from '../state/store';

export function LearnedOffer() {
  const { state, dispatch } = useStore();
  const live = useProfile();
  // Rules are an owner's or admin's to save.
  if (live && !live.profile.can.policy) return null;
  const offer = Object.values(state.ws.learned).find((r) => r.mail);
  if (!offer) return null;
  return (
    <section className="card learned-offer" aria-label="A rule Timmy could follow">
      <Sparkles size={16} aria-hidden />
      <div className="learned-offer-text">
        <p>
          <strong>{offer.evidence}</strong> Make it a rule?
        </p>
        <p className="muted">{offer.text}</p>
      </div>
      <div className="learned-offer-actions">
        <button className="btn btn-sm btn-ghost" onClick={() => declineLearned(dispatch, offer)}>
          No thanks
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => acceptLearned(dispatch, offer)}>
          Make it a rule
        </button>
      </div>
    </section>
  );
}
