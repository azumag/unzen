from __future__ import annotations

from itertools import combinations
from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from multi_segment_onnx import (  # noqa: E402
    BrowserArtifactBudgetError,
    _select_partition,
)


SpanCosts = dict[tuple[int, int], int]


def _all_partitions(
    total_layers: int,
    costs: SpanCosts,
) -> list[tuple[tuple[int, ...], tuple[int, ...]]]:
    """Enumerate every contiguous partition independently of the planner DP."""

    partitions: list[tuple[tuple[int, ...], tuple[int, ...]]] = []
    boundaries = tuple(range(1, total_layers))
    for cut_count in range(total_layers):
        for cuts in combinations(boundaries, cut_count):
            bounds = (0, *cuts, total_layers)
            segment_costs = tuple(
                costs[(start, end)]
                for start, end in zip(bounds, bounds[1:])
            )
            partitions.append((cuts, segment_costs))
    return partitions


def _oracle_partition(
    *,
    total_layers: int,
    target_bytes: int,
    required_max_bytes: int,
    costs: SpanCosts,
) -> tuple[tuple[int, ...], tuple[int, ...]] | None:
    """Apply the documented objectives directly over all possible partitions."""

    feasible = [
        (cuts, segment_costs)
        for cuts, segment_costs in _all_partitions(total_layers, costs)
        if max(segment_costs) <= required_max_bytes
    ]
    if not feasible:
        return None

    return min(
        feasible,
        key=lambda candidate: (
            len(candidate[1]),
            max(candidate[1]),
            sum(abs(cost - target_bytes) for cost in candidate[1]),
            candidate[0],
        ),
    )


def _synthetic_costs(total_layers: int, seed: int) -> SpanCosts:
    """Build deterministic, deliberately non-monotonic span costs."""

    return {
        (start, end): (
            (seed * 17)
            + ((start + 1) * 31)
            + (end * 47)
            + ((end - start) * 19)
            + ((start + end) * 7)
        )
        % 13
        for start in range(total_layers)
        for end in range(start + 1, total_layers + 1)
    }


class MultiSegmentPartitionExhaustiveOracleTest(unittest.TestCase):
    def test_dynamic_program_matches_exhaustive_oracle(self) -> None:
        for total_layers in range(1, 7):
            for seed in range(8):
                costs = _synthetic_costs(total_layers, seed)
                partitions = _all_partitions(total_layers, costs)
                global_minimum_maximum = min(
                    max(segment_costs)
                    for _cuts, segment_costs in partitions
                )

                for required_max_bytes in range(1, 9):
                    targets = {
                        1,
                        required_max_bytes,
                        max(1, required_max_bytes // 2),
                    }
                    for target_bytes in sorted(targets):
                        with self.subTest(
                            total_layers=total_layers,
                            seed=seed,
                            required_max_bytes=required_max_bytes,
                            target_bytes=target_bytes,
                        ):
                            expected = _oracle_partition(
                                total_layers=total_layers,
                                target_bytes=target_bytes,
                                required_max_bytes=required_max_bytes,
                                costs=costs,
                            )
                            if expected is not None:
                                actual = _select_partition(
                                    total_layers=total_layers,
                                    target_bytes=target_bytes,
                                    required_max_bytes=required_max_bytes,
                                    span_cost=lambda start, end: costs[(start, end)],
                                )
                                self.assertEqual(actual, expected)
                                continue

                            with self.assertRaises(BrowserArtifactBudgetError) as caught:
                                _select_partition(
                                    total_layers=total_layers,
                                    target_bytes=target_bytes,
                                    required_max_bytes=required_max_bytes,
                                    span_cost=lambda start, end: costs[(start, end)],
                                )

                            error = caught.exception
                            self.assertEqual(
                                error.minimum_achievable_maximum_bytes,
                                global_minimum_maximum,
                            )
                            self.assertEqual(
                                error.oversized_single_layer_spans,
                                tuple(
                                    (layer, costs[(layer, layer + 1)])
                                    for layer in range(total_layers)
                                    if costs[(layer, layer + 1)] > required_max_bytes
                                ),
                            )


if __name__ == "__main__":
    unittest.main()
