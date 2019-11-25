/*
 * Copyright 2017-2018 Allegro.pl
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Duration, Timezone } from "chronoshift";
import { List, OrderedSet, Set } from "immutable";
import { NamedArray } from "immutable-class";
import {
  AndExpression,
  ChainableExpression,
  ChainableUnaryExpression,
  ContainsExpression,
  Expression,
  InExpression,
  LiteralExpression,
  MatchExpression,
  NotExpression,
  OverlapExpression,
  Set as PlywoodSet,
  TimeBucketExpression,
  TimeFloorExpression,
  TimeRange,
  TimeRangeExpression
} from "plywood";
import { Colors } from "../../models/colors/colors";
import { DataCube } from "../../models/data-cube/data-cube";
import { DateRange } from "../../models/date-range/date-range";
import { Dimension } from "../../models/dimension/dimension";
import { Essence } from "../../models/essence/essence";
import {
  BooleanFilterClause,
  FilterClause,
  FixedTimeFilterClause,
  NumberFilterClause,
  NumberRange,
  RelativeTimeFilterClause,
  StringFilterAction,
  StringFilterClause,
  TimeFilterPeriod
} from "../../models/filter-clause/filter-clause";
import { Filter } from "../../models/filter/filter";
import { Highlight } from "../../models/highlight/highlight";
import { Manifest } from "../../models/manifest/manifest";
import { SeriesList } from "../../models/series-list/series-list";
import { DimensionSort, SeriesSort, Sort, SortType } from "../../models/sort/sort";
import { kindToType, Split } from "../../models/split/split";
import { Splits } from "../../models/splits/splits";
import { TimeShift } from "../../models/time-shift/time-shift";
import { ViewDefinitionConverter } from "../view-definition-converter";
import { ViewDefinition2 } from "./view-definition-2";

export type FilterSelection = Expression | string;

export class ViewDefinitionConverter2 implements ViewDefinitionConverter<ViewDefinition2, Essence> {
  version = 2;

  fromViewDefinition(definition: ViewDefinition2, dataCube: DataCube, visualizations: Manifest[]): Essence {
    const visualization = NamedArray.findByName(visualizations, definition.visualization);

    const measureNames = definition.multiMeasureMode ? definition.selectedMeasures : [definition.singleMeasure];
    const series = SeriesList.fromMeasureNames(measureNames);
    const timezone = definition.timezone && Timezone.fromJS(definition.timezone);
    const filter = Filter.fromClauses(filterJSConverter(definition.filter, dataCube));
    const pinnedDimensions = OrderedSet(definition.pinnedDimensions);
    const splits = Splits.fromSplits(splitJSConverter(definition.splits, dataCube));
    const timeShift = TimeShift.empty();
    const colors = definition.colors && Colors.fromJS(definition.colors);
    const pinnedSort = definition.pinnedSort;
    const highlight = readHighlight(definition.highlight, dataCube);
    const compare: any = null;
    return new Essence({ dataCube, visualizations, visualization, timezone, filter, timeShift, splits, pinnedDimensions, series, colors, pinnedSort, compare, highlight });
  }

  toViewDefinition(essence: Essence): ViewDefinition2 {
    throw new Error("toViewDefinition is not supported in Version 2");
  }
}

function readHighlight(definition: any, dataCube: DataCube): Highlight {
  if (!definition) return null;
  const { measure } = definition;
  const delta = Filter.fromClauses(filterJSConverter(definition.delta, dataCube));
  return new Highlight({ measure, delta });

}

function isBooleanFilterSelection(selection: FilterSelection): selection is LiteralExpression {
  return selection instanceof LiteralExpression && selection.type === "SET/BOOLEAN";
}

function isNumberFilterSelection(selection: FilterSelection): selection is LiteralExpression {
  return selection instanceof LiteralExpression && selection.type === "SET/NUMBER_RANGE";
}

function isFixedTimeRangeSelection(selection: FilterSelection): selection is LiteralExpression {
  return selection instanceof LiteralExpression && selection.type === "TIME_RANGE";
}

function isRelativeTimeRangeSelection(selection: FilterSelection): selection is TimeRangeExpression {
  return selection instanceof TimeRangeExpression || selection instanceof TimeBucketExpression;
}

function filterJSConverter(filter: any, dataCube: DataCube): FilterClause[] {
  const filterExpression = Expression.fromJSLoose(filter);
  if (filterExpression instanceof LiteralExpression && filterExpression.simple) return [];
  if (filterExpression instanceof AndExpression) {
    return filterExpression.getExpressionList().map(exp => convertFilterExpression(exp as ChainableUnaryExpression, dataCube));
  } else {
    return [convertFilterExpression(filterExpression as ChainableUnaryExpression, dataCube)];
  }
}

enum SupportedAction {
  overlap = "overlap",
  contains = "contains",
  match = "match"
}

function readBooleanFilterClause(selection: LiteralExpression, dimension: Dimension, not: boolean): BooleanFilterClause {
  const { name: reference } = dimension;

  return new BooleanFilterClause({ reference, values: Set(selection.value.elements), not });
}

function readNumberFilterClause(selection: LiteralExpression, dimension: Dimension, not: boolean): NumberFilterClause {
  const { name: reference } = dimension;

  if (isNumberFilterSelection(selection) && selection.value instanceof PlywoodSet) {
    const values = List(selection.value.elements.map((range: NumberRange) => new NumberRange(range)));
    return new NumberFilterClause({ reference, not, values });
  } else {
    throw new Error(`Number filterClause expected, found: ${selection}. Dimension: ${reference}`);
  }
}

function readFixedTimeFilter(selection: LiteralExpression, dimension: Dimension): FixedTimeFilterClause {
  const { name: reference } = dimension;

  return new FixedTimeFilterClause({ reference, values: List.of(new DateRange(selection.value as TimeRange)) });
}

function readRelativeTimeFilterClause({ step, duration, operand }: TimeRangeExpression, dimension: Dimension): RelativeTimeFilterClause {
  const { name: reference } = dimension;
  if (operand instanceof TimeFloorExpression) {
    return new RelativeTimeFilterClause({
      reference,
      duration: duration.multiply(Math.abs(step)),
      period: TimeFilterPeriod.PREVIOUS
    });
  }
  return new RelativeTimeFilterClause({
    reference,
    period: step ? TimeFilterPeriod.LATEST : TimeFilterPeriod.CURRENT,
    duration: step ? duration.multiply(Math.abs(step)) : duration
  });
}

function readStringFilterClause(selection: ChainableExpression, dimension: Dimension, exclude: boolean): StringFilterClause {
  const action = expressionAction(selection);
  const { name: reference } = dimension;

  switch (action) {
    case SupportedAction.contains:
      return new StringFilterClause({
        reference,
        action: StringFilterAction.CONTAINS,
        values: Set.of(((selection as ChainableUnaryExpression).expression as LiteralExpression).value),
        not: exclude
      });
    case SupportedAction.match:
      return new StringFilterClause({
        reference,
        action: StringFilterAction.MATCH,
        values: Set.of((selection as MatchExpression).regexp),
        not: exclude
      });
    case SupportedAction.overlap:
    case undefined:
    default:
      return new StringFilterClause({
        reference,
        action: StringFilterAction.IN,
        values: Set(((selection as ChainableUnaryExpression).expression as LiteralExpression).value.elements),
        not: exclude
      });
  }
}

function extractExclude(expression: ChainableUnaryExpression): { exclude: boolean, expression: ChainableUnaryExpression } {
  if (expression instanceof NotExpression) {
    return { exclude: true, expression: expression.operand as ChainableUnaryExpression };
  }
  return { exclude: false, expression };
}

function expressionAction(expression: ChainableExpression): SupportedAction {
  if (expression instanceof InExpression || expression instanceof OverlapExpression || expression instanceof ContainsExpression) {
    return expression.op as SupportedAction;
  }
  if (expression instanceof MatchExpression) {
    return SupportedAction.match;
  }
  throw new Error(`Unrecognized Supported Action for expression ${expression}`);
}

function convertFilterExpression(filter: ChainableUnaryExpression, dataCube: DataCube): FilterClause {
  const { expression, exclude } = extractExclude(filter);
  const dimension = dataCube.getDimensionByExpression(expression.operand);

  if (isBooleanFilterSelection(expression.expression)) {
    return readBooleanFilterClause(expression.expression, dimension, exclude);
  } else if (isNumberFilterSelection(expression.expression)) {
    return readNumberFilterClause(expression.expression, dimension, exclude);
  } else if (isFixedTimeRangeSelection(expression.expression)) {
    return readFixedTimeFilter(expression.expression, dimension);
  } else if (isRelativeTimeRangeSelection(expression.expression as ChainableExpression)) {
    return readRelativeTimeFilterClause(expression.expression as TimeRangeExpression, dimension);
  } else {
    return readStringFilterClause(expression, dimension, exclude);
  }
}

// Handle change in plywood internal representation around 0.14.0
function limitValue(limitAction: any): number {
  return limitAction.value || limitAction.limit;
}

// Handle change in plywood internal representation around 0.14.0
function isTimeBucket(action: any): boolean {
  return action.op === "timeBucket" || action.action === "timeBucket";
}

function createSort(sortAction: any, dataCube: DataCube): Sort {
  if (!sortAction) return null;
  const reference = sortAction.expression.name;
  const direction = sortAction.direction;
  if (dataCube.getDimension(sortAction.expression.name)) {
    return new DimensionSort({ reference, direction });
  }
  return new SeriesSort({ reference, direction });
}

function convertSplit(split: any, dataCube: DataCube): Split {
  const { sortAction, limitAction, bucketAction } = split;
  const expression = Expression.fromJS(split.expression);
  const dimension = dataCube.getDimensionByExpression(expression);
  const reference = dimension.name;
  const sort = createSort(sortAction, dataCube);
  const type = kindToType(dimension.kind);
  const limit = limitAction && limitValue(limitAction);
  const bucket = bucketAction && (isTimeBucket(bucketAction) ? Duration.fromJS(bucketAction.duration) : bucketAction.size);
  return new Split({ type, reference, sort, limit, bucket });
}

function splitJSConverter(splits: any[], dataCube: DataCube): Split[] {
  return splits.map(split => convertSplit(split, dataCube));
}