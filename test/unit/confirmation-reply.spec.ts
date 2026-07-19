import { interpretConfirmation } from '../../src/agents/calendar/pending-action/confirmation-reply';

describe('interpretConfirmation', () => {
  it.each([
    'yes',
    'Yes',
    'YES',
    'yes please',
    'y',
    'yep',
    'yeah',
    'sure',
    'ok',
    'okay',
    'confirm',
    'do it',
    'go ahead',
    'yes, go ahead',
    'yes.',
    '  yes  ',
    '👍',
  ])('reads %s as affirmative', (text) => {
    expect(interpretConfirmation(text)).toBe('affirmative');
  });

  it.each([
    'no',
    'No',
    'nope',
    'nah',
    'cancel',
    'stop',
    'never mind',
    'no thanks',
    "don't",
    'leave it',
    'no!',
    '👎',
  ])('reads %s as negative', (text) => {
    expect(interpretConfirmation(text)).toBe('negative');
  });

  /**
   * The ordering test. "no, cancel it" contains "cancel it", which is in the
   * affirmative set — but it is plainly a refusal. Negatives are checked first
   * precisely so this reads correctly, and on a destructive action the safe
   * misreading is always to decline.
   */
  it.each(['no, cancel it', 'no do not delete it', 'nope, leave it alone'])(
    'reads %s as negative despite containing affirmative words',
    (text) => {
      expect(interpretConfirmation(text)).toBe('negative');
    },
  );

  it.each([
    'maybe',
    'what was that again?',
    'the dentist one',
    'can you move it to 4pm instead',
    'hmm',
    '',
    '   ',
    'I think there is no way',
  ])('reads %s as unclear', (text) => {
    expect(interpretConfirmation(text)).toBe('unclear');
  });

  it('does not treat an embedded no as a refusal', () => {
    // "nothing" starts with "no" as a substring but is not the word "no";
    // matching on whole words is what keeps this from misfiring.
    expect(interpretConfirmation('nothing has changed yet')).toBe('unclear');
  });
});
