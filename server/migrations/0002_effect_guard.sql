-- Tightens the effect state machine after the phase 0 safety review.
-- What an approver was shown, who had to approve and on whose behalf can no longer
-- change after the effect is created, and an approval can only be written in the
-- same step that approves it.
create or replace function effect_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'intended' then
      if new.approved_by is not null then raise exception 'effect %: an intended effect cannot carry an approver', new.id; end if;
    elsif new.status = 'approved' then
      if new.approved_by is null or new.approved_via is null then raise exception 'effect %: approved without an approver', new.id; end if;
      if new.approved_via = 'rule' and new.policy_id is null then raise exception 'effect %: rule approval without a rule', new.id; end if;
    else
      raise exception 'effect %: cannot be created as %', new.id, new.status;
    end if;
    return new;
  end if;

  if new.kind is distinct from old.kind or new.payload is distinct from old.payload
     or new.payload_hash is distinct from old.payload_hash or new.idempotency_key is distinct from old.idempotency_key
     or new.workspace_id is distinct from old.workspace_id or new.requested_by is distinct from old.requested_by
     or new.source is distinct from old.source or new.preview is distinct from old.preview
     or new.approver_route is distinct from old.approver_route or new.on_behalf_of is distinct from old.on_behalf_of
     or new.target is distinct from old.target or new.run_id is distinct from old.run_id
     or new.command_id is distinct from old.command_id then
    raise exception 'effect %: what was approved cannot change', old.id;
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'intended'  and new.status in ('approved', 'declined', 'cancelled')) or
      (old.status = 'approved'  and new.status in ('executing', 'cancelled')) or
      (old.status = 'executing' and new.status in ('completed', 'uncertain', 'failed')) or
      (old.status = 'uncertain' and new.status in ('completed', 'failed'))
    ) then
      raise exception 'effect %: % cannot become %', old.id, old.status, new.status;
    end if;
    if new.status = 'approved' and (new.approved_by is null or new.approved_via is null) then
      raise exception 'effect %: approved without an approver', old.id;
    end if;
    if new.status = 'approved' and new.approved_via = 'rule' and new.policy_id is null then
      raise exception 'effect %: rule approval without a rule', old.id;
    end if;
    if new.status = 'executing' and old.approved_by is null then
      raise exception 'effect %: cannot run without an approval', old.id;
    end if;
    -- The approval is written by the step that approves, and by no other.
    if not (old.status = 'intended' and new.status = 'approved')
       and (new.approved_by is distinct from old.approved_by or new.approved_via is distinct from old.approved_via or new.policy_id is distinct from old.policy_id) then
      raise exception 'effect %: the approval cannot change', old.id;
    end if;
  elsif new.approved_by is distinct from old.approved_by or new.approved_via is distinct from old.approved_via or new.policy_id is distinct from old.policy_id then
    raise exception 'effect %: the approval cannot change', old.id;
  end if;
  -- The hold can be set when approving and shortened while waiting; it means nothing once the effect has started.
  if new.hold_until is distinct from old.hold_until and old.status not in ('intended', 'approved') then
    raise exception 'effect %: the hold cannot change once it has started', old.id;
  end if;
  new.updated_at := now();
  return new;
end $$;
