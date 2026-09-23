// lib/widgets/branded_map_tile.dart
//
// EXACTLY the same tile rendering the DRIVER app uses: OSM standard
// basemap color-tuned with the app's light channel-scaling and warm paper
// tint. The rider map must look and behave identically to the driver's.

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart' show TileImage;

Widget brandedMapTile(BuildContext context, Widget tileWidget, TileImage tile) {
  return ColorFiltered(
    colorFilter: const ColorFilter.matrix(<double>[
      0.937,
      0,
      0,
      0,
      0,
      0,
      0.922,
      0,
      0,
      0,
      0,
      0,
      0.902,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
    ]),
    child: ColorFiltered(
      colorFilter: ColorFilter.mode(
        const Color(0xFFEEEBE6).withOpacity(0.3),
        BlendMode.multiply,
      ),
      child: tileWidget,
    ),
  );
}