import { AmoService } from './amo.service';

describe('AmoService webhook parsing', () => {
  const service = new AmoService({} as any, {} as any, {} as any, {} as any);

  it('parses amoCRM form-encoded lead status webhook keys', () => {
    const events = service.flattenWebhook({
      'leads[status][0][id]': '25399013',
      'leads[status][0][old_status_id]': '7039101',
      'leads[status][0][status_id]': '142',
      'leads[status][0][account_id]': '7039099',
      'account[subdomain]': 'servermallvilnius',
    });

    expect(events).toEqual([
      {
        entity: 'leads',
        action: 'status',
        externalId: '25399013',
        payload: {
          id: '25399013',
          old_status_id: '7039101',
          status_id: '142',
          account_id: '7039099',
        },
      },
    ]);
  });

  it('parses form webhook keys when scalar and nested values share a path', () => {
    const events = service.flattenWebhook({
      'contacts[note][0][note][id]': '60864725',
      'contacts[note][0][note][type]': '3',
      'contacts[note][0][note][type][message_uuid]': '70f31734-fb5f-4b8e-99a2-5acfe7ca53f43',
      'contacts[note][0][note][element_id]': '40700289',
      'account[subdomain]': 'servermallvilnius',
    });

    expect(events).toEqual([
      {
        entity: 'contacts',
        action: 'note',
        externalId: null,
        payload: {
          note: {
            id: '60864725',
            type: {
              value: '3',
              message_uuid: '70f31734-fb5f-4b8e-99a2-5acfe7ca53f43',
            },
            element_id: '40700289',
          },
        },
      },
    ]);
  });

  it('parses already nested webhook bodies', () => {
    const events = service.flattenWebhook({
      leads: {
        update: [
          {
            id: '25399013',
            name: 'Lead title',
          },
        ],
      },
      account: {
        subdomain: 'servermallvilnius',
      },
    });

    expect(events).toEqual([
      {
        entity: 'leads',
        action: 'update',
        externalId: '25399013',
        payload: {
          id: '25399013',
          name: 'Lead title',
        },
      },
    ]);
  });
});
