/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @providesModule RelayFlowGenerator
 * @flow
 * @format
 */

'use strict';

const PatchedBabelGenerator = require('./PatchedBabelGenerator');
const RelayMaskTransform = require('RelayMaskTransform');

const nullthrows = require('nullthrows');
const t = require('babel-types');

const {
  FlattenTransform,
  IRVisitor,
  SchemaUtils,
} = require('../graphql-compiler/GraphQLCompilerPublic');
const {
  anyTypeAlias,
  exactObjectTypeAnnotation,
  exportType,
  fragmentReference,
  importTypes,
  intersectionTypeAnnotation,
  lineComments,
  readOnlyArrayOfType,
  readOnlyObjectTypeProperty,
  stringLiteralTypeAnnotation,
  unionTypeAnnotation,
} = require('./RelayFlowBabelFactories');
const {
  transformScalarType,
  transformInputType,
} = require('./RelayFlowTypeTransformers');
const {
  GraphQLNonNull,
  GraphQLInputObjectType,
} = require('graphql');

import type {
  IRTransform,
  Fragment,
  Root,
  CompilerContext,
} from '../graphql-compiler/GraphQLCompilerPublic';
import type {ScalarTypeMapping} from './RelayFlowTypeTransformers';
import type {GraphQLEnumType} from 'graphql';

const {isAbstractType} = SchemaUtils;

type Options = {|
  +customScalars: ScalarTypeMapping,
  +inputFieldWhiteList: $ReadOnlyArray<string>,
  +recursiveFields: $ReadOnlyArray<string>,
  +recursionLimit: number,
  +relayRuntimeModule: string,
  +enumsHasteModule: ?string,
|};

export type State = {|
  ...Options,
  +recursionLevel: number,
  +usedFragments: Set<string>,
  +usedEnums: {[name: string]: GraphQLEnumType},
|};

function generate(node: Root | Fragment, options: Options): string {
  const ast = IRVisitor.visit(node, createVisitor(options));
  return PatchedBabelGenerator.generate(ast);
}

type Selection = {
  key: string,
  schemaName?: string,
  value?: any,
  nodeType?: any,
  conditional?: boolean,
  concreteType?: string,
  ref?: string,
  nodeSelections?: ?SelectionMap,
};
type SelectionMap = Map<string, Selection>;

function makeProp(
  {key, schemaName, value, conditional, nodeType, nodeSelections}: Selection,
  state: State,
  concreteType?: string,
) {
  if (nodeType) {
    value = transformScalarType(
      nodeType,
      state,
      selectionsToBabel(
        [Array.from(nullthrows(nodeSelections).values())],
        state,
      ),
    );
  }
  if (schemaName === '__typename' && concreteType) {
    value = stringLiteralTypeAnnotation(concreteType);
  }
  const typeProperty = readOnlyObjectTypeProperty(key, value);
  if (conditional) {
    typeProperty.optional = true;
  }
  return typeProperty;
}

const isTypenameSelection = selection => selection.schemaName === '__typename';
const hasTypenameSelection = selections => selections.some(isTypenameSelection);
const onlySelectsTypename = selections => selections.every(isTypenameSelection);

function selectionsToBabel(selections, state: State) {
  const baseFields = new Map();
  const byConcreteType = {};

  flattenArray(selections).forEach(selection => {
    const {concreteType} = selection;
    if (concreteType) {
      byConcreteType[concreteType] = byConcreteType[concreteType] || [];
      byConcreteType[concreteType].push(selection);
    } else {
      const previousSel = baseFields.get(selection.key);

      baseFields.set(
        selection.key,
        previousSel ? mergeSelection(selection, previousSel) : selection,
      );
    }
  });

  const types = [];

  if (
    Object.keys(byConcreteType).length &&
    onlySelectsTypename(Array.from(baseFields.values())) &&
    (hasTypenameSelection(Array.from(baseFields.values())) ||
      Object.keys(byConcreteType).every(type =>
        hasTypenameSelection(byConcreteType[type]),
      ))
  ) {
    for (const concreteType in byConcreteType) {
      types.push(
        exactObjectTypeAnnotation(
          groupRefs([
            ...Array.from(baseFields.values()),
            ...byConcreteType[concreteType],
          ]).map(selection => makeProp(selection, state, concreteType)),
        ),
      );
    }
    // It might be some other type then the listed concrete types. Ideally, we
    // would set the type to diff(string, set of listed concrete types), but
    // this doesn't exist in Flow at the time.
    const otherProp = readOnlyObjectTypeProperty(
      '__typename',
      stringLiteralTypeAnnotation('%other'),
    );
    otherProp.leadingComments = lineComments(
      "This will never be '%other', but we need some",
      'value in case none of the concrete values match.',
    );
    types.push(exactObjectTypeAnnotation([otherProp]));
  } else {
    let selectionMap = selectionsToMap(Array.from(baseFields.values()));
    for (const concreteType in byConcreteType) {
      selectionMap = mergeSelections(
        selectionMap,
        selectionsToMap(
          byConcreteType[concreteType].map(sel => ({
            ...sel,
            conditional: true,
          })),
        ),
      );
    }
    const selectionMapValues = groupRefs(Array.from(selectionMap.values())).map(
      sel =>
        isTypenameSelection(sel) && sel.concreteType
          ? makeProp({...sel, conditional: false}, state, sel.concreteType)
          : makeProp(sel, state),
    );
    types.push(exactObjectTypeAnnotation(selectionMapValues));
  }

  return unionTypeAnnotation(types);
}

function mergeSelection(a: ?Selection, b: Selection): Selection {
  if (!a) {
    return {
      ...b,
      conditional: true,
    };
  }
  return {
    ...a,
    nodeSelections: a.nodeSelections
      ? mergeSelections(a.nodeSelections, nullthrows(b.nodeSelections))
      : null,
    conditional: a.conditional && b.conditional,
  };
}

function mergeSelections(a: SelectionMap, b: SelectionMap): SelectionMap {
  const merged = new Map();
  for (const [key, value] of a.entries()) {
    merged.set(key, value);
  }
  for (const [key, value] of b.entries()) {
    merged.set(key, mergeSelection(a.get(key), value));
  }
  return merged;
}

function isPlural({directives}): boolean {
  const relayDirective = directives.find(({name}) => name === 'relay');
  return (
    relayDirective != null &&
    relayDirective.args.some(
      ({name, value}) => name === 'plural' && value.value,
    )
  );
}

function createVisitor(options: Options) {
  const state = {
    customScalars: options.customScalars,
    enumsHasteModule: options.enumsHasteModule,
    inputFieldWhiteList: options.inputFieldWhiteList,
    relayRuntimeModule: options.relayRuntimeModule,
    recursiveFields: options.recursiveFields,
    recursionLimit: options.recursionLimit,
    recursionLevel: 0,
    usedEnums: {},
    usedFragments: new Set(),
  };

  return {
    leave: {
      Root(node) {
        const inputVariablesType =
          node.operation !== 'query'
            ? generateInputVariablesType(node, state)
            : null;
        const responseType = exportType(
          `${node.name}Response`,
          selectionsToBabel(node.selections, state),
        );
        return t.program([
          ...getFragmentImports(state),
          ...getEnumDefinitions(state),
          ...(inputVariablesType ? [inputVariablesType] : []),
          responseType,
        ]);
      },

      Fragment(node) {
        let selections = flattenArray(node.selections);
        const numConecreteSelections = selections.filter(s => s.concreteType)
          .length;
        selections = selections.map(selection => {
          if (
            numConecreteSelections <= 1 &&
            isTypenameSelection(selection) &&
            !isAbstractType(node.type)
          ) {
            return [
              {
                ...selection,
                concreteType: node.type.toString(),
              },
            ];
          }
          return [selection];
        });
        const baseType = selectionsToBabel(selections, state);
        const type = isPlural(node) ? readOnlyArrayOfType(baseType) : baseType;

        return t.program([
          ...getFragmentImports(state),
          ...getEnumDefinitions(state),
          exportType(node.name, type),
        ]);
      },

      InlineFragment(node) {
        const typeCondition = node.typeCondition;
        return flattenArray(node.selections).map(typeSelection => {
          return isAbstractType(typeCondition)
            ? {
                ...typeSelection,
                conditional: true,
              }
            : {
                ...typeSelection,
                concreteType: typeCondition.toString(),
              };
        });
      },
      Condition(node) {
        return flattenArray(node.selections).map(selection => {
          return {
            ...selection,
            conditional: true,
          };
        });
      },
      ScalarField(node) {
        return [
          {
            key: node.alias || node.name,
            schemaName: node.name,
            value: transformScalarType(node.type, state),
          },
        ];
      },
      LinkedField(node) {
        return [
          {
            key: node.alias || node.name,
            schemaName: node.name,
            nodeType: node.type,
            nodeSelections: selectionsToMap(flattenArray(node.selections)),
          },
        ];
      },
      FragmentSpread(node) {
        state.usedFragments.add(node.name);
        return [
          {
            key: '__fragments_' + node.name,
            ref: node.name,
          },
        ];
      },
    },
  };
}

function selectionsToMap(selections: Array<Selection>): SelectionMap {
  const map = new Map();
  selections.forEach(selection => {
    const previousSel = map.get(selection.key);
    map.set(
      selection.key,
      previousSel ? mergeSelection(previousSel, selection) : selection,
    );
  });
  return map;
}

function flattenArray<T>(arrayOfArrays: Array<Array<T>>): Array<T> {
  const result = [];
  arrayOfArrays.forEach(array => result.push(...array));
  return result;
}

function generateInputVariablesType(node: Root, state: State) {
  return exportType(
    `${node.name}Variables`,
    exactObjectTypeAnnotation(
      node.argumentDefinitions.map(arg => {
        const property = t.objectTypeProperty(
          t.identifier(arg.name),
          transformInputType(arg.type, state),
        );
        if (!(arg.type instanceof GraphQLNonNull)) {
          property.optional = true;
        }
        return property;
      }),
    ),
  );
}

function groupRefs(props): Array<Selection> {
  const result = [];
  const refs = [];
  props.forEach(prop => {
    if (prop.ref) {
      refs.push(prop.ref);
    } else {
      result.push(prop);
    }
  });
  if (refs.length > 0) {
    const value = intersectionTypeAnnotation(refs.map(fragmentReference));
    result.push({
      key: '__fragments',
      conditional: false,
      value,
    });
  }
  return result;
}

function getFragmentImports(state: State) {
  const imports = [];
  if (state.usedFragments.size > 0) {
    imports.push(importTypes(['FragmentReference'], state.relayRuntimeModule));
    // TODO: test for existance of the referenced fragment and generate
    // import type if the fragment exist (it might not exist in compat mode).
    const usedFragments = Array.from(state.usedFragments).sort();
    for (const usedFragment of usedFragments) {
      imports.push(anyTypeAlias(usedFragment));
      // importTypes([includedSpreadType], includedSpreadType + '.graphql')
    }
  }
  return imports;
}

function getEnumDefinitions({enumsHasteModule, usedEnums}: State) {
  const enumNames = Object.keys(usedEnums).sort();
  if (enumNames.length === 0) {
    return [];
  }
  if (enumsHasteModule) {
    return [importTypes(enumNames, enumsHasteModule)];
  }
  return enumNames.map(name => {
    const values = usedEnums[name].getValues().map(({value}) => value);
    values.sort();
    values.push('%future added value');
    return exportType(
      name,
      t.unionTypeAnnotation(
        values.map(value => stringLiteralTypeAnnotation(value)),
      ),
    );
  });
}

const FLOW_TRANSFORMS: Array<IRTransform> = [
  RelayMaskTransform.transform,
  (ctx: CompilerContext) => FlattenTransform.transform(ctx, {}),
];

module.exports = {
  generate,
  flowTransforms: FLOW_TRANSFORMS,
};
