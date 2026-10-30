#!/usr/bin/env python3
"""Read-only report of migration timing; inclusive durations are not additive."""
import argparse
import json
from collections import defaultdict
from pathlib import Path


def report(data_dir):
    root = Path(data_dir) / 'legacy-migration'
    state_file = root / 'state.json'
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    grouped = defaultdict(list)
    incomplete_lines = 0
    for path in sorted((root / 'timings').glob('*.jsonl')):
        for line in path.read_text().splitlines():
            try:
                event = json.loads(line)
            except (ValueError, TypeError):
                incomplete_lines += 1
                continue
            key = event.get('taskId') or event.get('batchId') or 'planning'
            grouped[key].append(event)

    def summarize(events):
        stages = defaultdict(lambda: {'calls': 0, 'durationMs': 0, 'maxMs': 0, 'failures': 0})
        models, queries, operations = [], [], []
        queue = {'calls': 0, 'queueWaitMs': 0, 'executeMs': 0}
        unfinished = set()
        for event in events:
            if event.get('event') == 'stage.start':
                unfinished.add(event.get('eventId'))
            if event.get('event') == 'stage.end':
                unfinished.discard(event.get('eventId'))
            if 'durationMs' in event:
                stage = stages[event['stage']]
                duration = float(event['durationMs'])
                stage['calls'] += 1
                stage['durationMs'] += duration
                stage['maxMs'] = max(stage['maxMs'], duration)
                stage['failures'] += event.get('status') not in ('ok', 'returned')
            if event.get('model'):
                models.append({'model': event['model'], 'usage': event.get('usage'),
                               'durationMs': event.get('durationMs'), 'finishReason': event.get('finishReason')})
            if event.get('event') == 'query':
                queries.append({k: event.get(k) for k in ['queryChars', 'beforeTotalCapChars', 'messageCount']})
            if event.get('event') == 'memory.operations':
                operations.append({k: event.get(k) for k in ['written', 'edited', 'deleted']})
            if event.get('event') == 'index.queue':
                queue['calls'] += 1
                for key in ['queueWaitMs', 'executeMs']:
                    queue[key] += event.get(key, 0)
        return {'stages': dict(stages), 'models': models, 'queries': queries,
                'operations': operations, 'embeddingQueue': queue, 'unfinishedSpans': len(unfinished)}

    def receipt_metadata(attempt):
        result = {}
        receipt_file = Path(data_dir) / 'openviking-adapter/ingests' / ((attempt.get('ingestId') or '') + '.json')
        if receipt_file.exists():
            receipt = json.loads(receipt_file.read_text())
            task = receipt.get('terminal', {}).get('task', {})
            result['submittedAt'] = receipt.get('createdAt')
            result['taskCreatedAt'] = task.get('created_at')
            result['taskUpdatedAt'] = task.get('updated_at')
            if task.get('created_at') and task.get('updated_at'):
                result['taskWallMs'] = (task['updated_at'] - task['created_at']) * 1000
        return result

    batches = []
    for number, batch in enumerate(state.get('batches', []), 1):
        attempts, all_events = [], []
        for attempt in [*batch.get('attempts', []), batch]:
            attempt_number = attempt.get('attempt', 0)
            events = list(grouped.get(attempt.get('taskId'), []))
            events.extend(e for e in grouped.get(batch['id'], []) if e.get('attempt', 0) == attempt_number)
            all_events.extend(events)
            attempts.append({'attempt': attempt_number, 'trigger': attempt.get('trigger', 'primary'),
                             'taskId': attempt.get('taskId'), 'status': attempt['status'],
                             **summarize(events), **receipt_metadata(attempt)})
        batches.append({'batch': number, 'batchId': batch['id'], 'taskId': batch.get('taskId'),
                        'status': batch['status'], 'sourceTokens': batch.get('tokens'),
                        **summarize(all_events), **receipt_metadata(batch), 'attempts': attempts})
    return {'version': 1, 'durationSemantics': 'Inclusive cumulative durations overlap; do not add stages to infer wall time.',
            'invalidOrPartialLines': incomplete_lines, 'planning': summarize(grouped['planning']), 'batches': batches,
            'total': summarize([event for events in grouped.values() for event in events])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', default='/var/lib/violoop-mem-ov')
    args = parser.parse_args()
    print(json.dumps(report(args.data_dir), ensure_ascii=False, indent=2))
