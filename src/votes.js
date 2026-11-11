// Голосование за приоритет идей. У каждого сотрудника VOTE_BUDGET голосов на открытые идеи из ленты,
// на одну идею — не больше VOTES_PER_IDEA. Голоса с рассмотренных идей возвращаются автоматически.
// Кто как голосовал, не показывается никому — только сумма по идее.
import { FINAL_STATUSES } from './config.js';
import { badRequest } from './http.js';
import { getVisibleTicketRow, isFinal } from './tickets-query.js';

export const VOTE_BUDGET = 5;
export const VOTES_PER_IDEA = 3;

const FINAL_SQL = `(${FINAL_STATUSES.map((s) => `'${s}'`).join(',')})`;

export function votesUsed(db, userId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(v.count), 0) AS n FROM idea_votes v JOIN tickets t ON t.id = v.ticket_id
       WHERE v.user_id = ? AND t.status NOT IN ${FINAL_SQL} AND t.is_public = 1 AND t.type = 'idea'`,
    )
    .get(userId).n;
}

const myVotesOn = (db, userId, ticketId) =>
  db.prepare('SELECT count FROM idea_votes WHERE ticket_id = ? AND user_id = ?').get(ticketId, userId)?.count ?? 0;

export function voteSummary(db, userId) {
  const used = votesUsed(db, userId);
  // После повторного открытия идеи голоса могут превысить запас — тогда свободных просто нет.
  return { budget: VOTE_BUDGET, perIdea: VOTES_PER_IDEA, used, left: Math.max(0, VOTE_BUDGET - used) };
}

// За что можно голосовать: опубликованное, ещё не рассмотренное предложение не своего авторства.
export function canVoteFor(row, user) {
  return Boolean(row.is_public) && row.type === 'idea' && !isFinal(row.status) && row.author_id !== user.id;
}

/** Состояние голосования для карточки обращения. */
export function ticketVoting(db, user, row) {
  return { ...voteSummary(db, user.id), mine: myVotesOn(db, user.id, row.id), canVote: canVoteFor(row, user) };
}

export function castVote(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (row.author_id === user.id) throw badRequest('Нельзя голосовать за собственную идею');
  if (!row.is_public || row.type !== 'idea') throw badRequest('Голосовать можно только за предложения из «Идей коллег»');
  if (isFinal(row.status)) throw badRequest('Идея уже рассмотрена — голоса вернулись к вам');
  const { count } = input;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > VOTES_PER_IDEA) {
    throw badRequest(`На одну идею — от 0 до ${VOTES_PER_IDEA} голосов`);
  }
  const usedElsewhere = votesUsed(db, user.id) - myVotesOn(db, user.id, row.id);
  if (usedElsewhere + count > VOTE_BUDGET) {
    // Уменьшать голоса можно всегда, даже если после повторного открытия идей запас превышен.
    if (count > myVotesOn(db, user.id, row.id)) {
      throw badRequest(`Голосов не хватает: свободно ${Math.max(0, VOTE_BUDGET - usedElsewhere)} из ${VOTE_BUDGET}. Снимите голоса с другой идеи.`);
    }
  }
  if (count === 0) {
    db.prepare('DELETE FROM idea_votes WHERE ticket_id = ? AND user_id = ?').run(row.id, user.id);
    return;
  }
  db.prepare(
    `INSERT INTO idea_votes (ticket_id, user_id, count, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(ticket_id, user_id) DO UPDATE SET count = excluded.count, created_at = excluded.created_at`,
  ).run(row.id, user.id, count, now);
}
