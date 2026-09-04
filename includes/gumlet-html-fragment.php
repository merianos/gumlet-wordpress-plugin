<?php
/**
 * Normalize HTML snippets before DOMDocument::loadHTML (JSON-escaped quotes/slashes).
 *
 * @param string $fragment Raw matched tag from output buffer.
 *
 * @return string
 * @package gumlet-wordpress
 */
function gumlet_normalize_html_fragment_for_dom( string $fragment ) : string {
    if ( $fragment === '' ) {
        return $fragment;
    }
    if ( function_exists( 'wp_unslash' ) ) {
        $fragment = wp_unslash( $fragment );
    } else {
        $fragment = stripslashes( $fragment );
    }
    // JSON encodes forward slashes in URLs as \/ — libxml needs real slashes.
    $fragment = str_replace( '\\/', '/', $fragment );

    // DOMDocument::loadHTML has no charset hint and defaults to ISO-8859-1,
    // mangling multibyte UTF-8 (e.g. Greek alt/title text). This pseudo
    // declaration tells libxml the real encoding without adding a DOM node.
    return '<?xml encoding="UTF-8">'.$fragment;
}
