// Client contact database: listing, sources, outreach status, manual adds (held), notes and Excel export. WIPES the target database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

process.env.SCHEDULER = 'off';

const { q, one, migrate } = await import('../src/db.js');
const { listContacts, createContact, updateContact, exportContacts, fillNamesFromEmail } = await import('../src/contacts.js');

test('client contact database', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies, suppressions, protected_accounts, tasks, events RESTART IDENTITY CASCADE');
  const e1 = await one(`INSERT INTO employers (name, norm_name, domain, type, city, state, sources) VALUES ('Christus Health','christus health','christushealth.org','Hospital / health system','Texarkana','TX','{PM}') RETURNING id`);
  const e2 = await one(`INSERT INTO employers (name, norm_name, type, city, state, sources, status) VALUES ('Ballad Health','ballad health','Hospital / health system','Johnson City','TN','{PM}','protected') RETURNING id`);
  const liz = await one(`INSERT INTO contacts (employer_id, first_name, last_name, full_name, title, email, sources) VALUES ($1,'Liz','Ray','Liz Ray','Physician Recruiter','liz.ray@christushealth.org','{PM}') RETURNING id`, [e1.id]);
  await q(`INSERT INTO contacts (employer_id, email, sources) VALUES ($1,'mnstelmat@practicematch.com','{PM}')`, [e1.id]);
  await q(`INSERT INTO contacts (employer_id, full_name, email, sources) VALUES ($1,'Alan Novak','anovak@balladhealth.org','{Lusha}')`, [e2.id]);
  await q(`INSERT INTO openings (employer_id, source, external_id, specialty, role, title, city, state, url, pm_code, contact_email, posted_at)
           VALUES ($1,'PM','1176353','Cardiology','Physician','Cardiology Physician','Texarkana','TX','https://www.practicematch.com/physicians/job-details.cfm/1176353','1176353MS','liz.ray@christushealth.org', now())`, [e1.id]);
  const seq = await one(`INSERT INTO sequences (employer_id, contact_id, step, status) VALUES ($1,$2,1,'active') RETURNING id`, [e1.id, liz.id]);
  await q(`INSERT INTO messages (sequence_id, employer_id, contact_id, step, to_email, subject, body, status) VALUES ($1,$2,$3,0,'liz.ray@christushealth.org','Hi','x','sent')`, [seq.id, e1.id, liz.id]);

  let rows = await listContacts();
  assert.equal(rows.length, 3);
  const L = rows.find((r) => r.email === 'liz.ray@christushealth.org');
  assert.deepEqual(L.foundVia, ['PracticeMatch']);
  assert.equal(L.jobs[0].code, '1176353MS');
  assert.equal(L.outreach, 'In sequence');
  assert.equal(L.sent_count, 1);
  assert.equal(rows.find((r) => r.email === 'mnstelmat@practicematch.com').relay, true);
  assert.equal(rows.find((r) => r.employer === 'Ballad Health').outreach, 'Current client');

  // Replies change the status
  await q(`INSERT INTO replies (employer_id, contact_id, from_email, received_at, category) VALUES ($1,$2,'liz.ray@christushealth.org', now(), 'interested')`, [e1.id, liz.id]);
  assert.equal((await listContacts({ search: 'liz' }))[0].outreach, 'Interested');

  // Filters
  assert.equal((await listContacts({ direct: '1' })).length, 2, 'direct only hides PracticeMatch forwarding addresses');
  assert.equal((await listContacts({ source: 'Lusha' })).length, 1);
  assert.equal((await listContacts({ state: 'tn' })).length, 1);
  assert.equal((await listContacts({ status: 'Interested' })).length, 1);

  // Manual add: new client is held (no automated emails); notes save
  const r = await createContact({ name: 'Jane Smith', title: 'CMO', email: 'jane@riverside.org', company: 'Riverside Regional', state: 'TX', notes: 'Met at TMA' });
  const emp = await one(`SELECT e.decision, e.domain FROM employers e JOIN contacts c ON c.employer_id = e.id WHERE c.id = $1`, [r.id]);
  assert.equal(emp.decision, 'held');
  assert.equal(emp.domain, 'riverside.org');
  await updateContact(r.id, { notes: 'Call back in January' });
  const jane = (await listContacts({ search: 'January' }))[0];
  assert.equal(jane.name, 'Jane Smith');
  assert.deepEqual(jane.foundVia, ['Added by you']);
  await assert.rejects(() => createContact({ name: 'No Company' }), /company/);

  // Names worked out from email addresses
  const e3 = await one(`INSERT INTO employers (name, norm_name, sources) VALUES ('Baptist Memorial','baptist memorial','{PM}') RETURNING id`);
  await q(`INSERT INTO contacts (employer_id, first_name, full_name, email, sources) VALUES ($1,'Ann','Ann','ann.lee@baptist.org','{PM}'), ($1,NULL,NULL,'mark.jones@baptist.org','{PM}'), ($1,NULL,NULL,'recruitment@baptist.org','{PM}'), ($1,'Bo','Bo','robert.king@baptist.org','{PM}')`, [e3.id]);
  assert.equal(await fillNamesFromEmail(), 2);
  const names = Object.fromEntries((await q(`SELECT email, full_name, first_name, last_name FROM contacts WHERE employer_id = $1`, [e3.id])).map((r) => [r.email, r]));
  assert.equal(names['ann.lee@baptist.org'].full_name, 'Ann Lee');
  assert.equal(names['mark.jones@baptist.org'].last_name, 'Jones');
  assert.equal(names['recruitment@baptist.org'].full_name, null, 'team mailboxes stay nameless');
  assert.equal(names['robert.king@baptist.org'].full_name, 'Bo', 'a name that disagrees with the address is left alone');
  const { addContact } = await import('../src/engine/ingest.js');
  const added = await addContact(e3.id, { email: 'sara.diaz@baptist.org' }, 'PM');
  assert.equal(added.contact.full_name, 'Sara Diaz');

  // Excel export
  const x = await exportContacts({});
  assert.equal(x.count, 9);
  const { writeFileSync: w } = await import('node:fs');
  assert.match(x.__file.name, /^MedConnect-Contacts-\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.equal(x.__file.data.subarray(0, 2).toString(), 'PK');
  writeFileSync('/tmp/contacts-test.xlsx', x.__file.data);
});
