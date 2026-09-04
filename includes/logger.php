<?php
/**
 * User: adityapatadia
 * Date: 27.04.2020
 */

class GumletLogger {
    private static GumletLogger $instance;
    private string              $logPath;

    /**
     * Make sure only one instance is running.
     */
    public static function instance() : GumletLogger {
        if ( !isset ( self::$instance ) ) {
            self::$instance = new self;
        }
        return self::$instance;
    }

    private function __construct() {
        $upload_dir    = wp_upload_dir();
        $this->logPath = $upload_dir[ 'basedir' ].'/gumlet_logs.log';
        if ( GUMLET_DEBUG === 'delete' ) {
            @unlink( $this->logPath );
            $this->log( "START FRESH", GUMLET_DEBUG );
        }
    }

    public function log( $msg, $extra = false ) : void {
        if ( GUMLET_DEBUG ) {
            file_put_contents(
                $this->logPath,
                sprintf(
                    "[%s] %s%s\n",
                    date( 'Y-m-d H:i:s' ),
                    $msg,
                    $extra ? json_encode( $extra, JSON_PRETTY_PRINT ) : ''
                ),
                FILE_APPEND
            );
        }
    }
}
