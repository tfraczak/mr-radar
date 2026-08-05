import { describe, expect, it } from 'vitest';
import { buildJql, DEFAULT_CONFIG, ownerClause, type Config } from '../src/core/config';
import { userFieldsFromCatalog } from '../src/core/sources/jira';

const withJira = (over: Partial<Config['jira']>): Config =>
  ({ ...DEFAULT_CONFIG, jira: { ...DEFAULT_CONFIG.jira, ...over } }) as Config;

describe('ownerClause / buildJql', () => {
  it('the default renders byte-identical to the historical hardcoded query', () => {
    const cfg = withJira({ activeStatuses: ['In Development', 'Code Review'] });
    expect(buildJql(cfg)).toBe(
      '(assignee = currentUser() OR watcher = currentUser()) AND status IN ("In Development", "Code Review") ORDER BY updated DESC',
    );
  });

  it('cf[…] ids pass verbatim; display names get quote-escaped', () => {
    const cfg = withJira({
      ownerFields: [
        { clause: 'assignee', label: 'Assignee' },
        { clause: 'cf[10123]', label: 'Dev Resource' },
        { clause: 'Weird "Field" \\ name', label: 'Weird' },
      ],
    });
    expect(ownerClause(cfg)).toBe(
      '(assignee = currentUser() OR cf[10123] = currentUser() OR "Weird \\"Field\\" \\\\ name" = currentUser())',
    );
  });

  it('blank clauses are skipped; jira.jql still overrides everything', () => {
    const cfg = withJira({
      ownerFields: [{ clause: '  ', label: 'blank' }, { clause: 'assignee', label: 'A' }],
    });
    expect(ownerClause(cfg)).toBe('(assignee = currentUser())');
    expect(buildJql(withJira({ jql: 'project = ENG' }))).toBe('project = ENG');
  });
});

describe('userFieldsFromCatalog', () => {
  it('keeps user and array-of-user fields, mapping custom ones to cf[id]', () => {
    const fields = userFieldsFromCatalog([
      { id: 'assignee', name: 'Assignee', custom: false, schema: { type: 'user' } },
      { id: 'reporter', name: 'Reporter', custom: false, schema: { type: 'user' } },
      {
        id: 'customfield_10123',
        name: 'Dev Resource',
        custom: true,
        schema: { type: 'user', customId: 10123 },
      },
      {
        id: 'customfield_10200',
        name: 'Approvers',
        custom: true,
        schema: { type: 'array', items: 'user', customId: 10200 },
      },
      { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
      { id: 'labels', name: 'Labels', custom: false, schema: { type: 'array', items: 'string' } },
      { id: 'customfield_9', name: 'Broken', custom: true, schema: { type: 'user' } }, // no customId
      { id: 'created', name: 'Created', custom: false }, // no schema at all
    ]);
    expect(fields).toEqual([
      { clause: 'cf[10200]', label: 'Approvers' },
      { clause: 'assignee', label: 'Assignee' },
      { clause: 'cf[10123]', label: 'Dev Resource' },
      { clause: 'reporter', label: 'Reporter' },
    ]);
  });
});
