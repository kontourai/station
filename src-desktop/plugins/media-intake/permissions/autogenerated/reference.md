## Default Permission

Read images from the system clipboard when the person asks to paste one, take images shared into Station from another app (`take_shared_images`), and listen for the `sharedImages` nudge. Returns image bytes only; never writes the clipboard or opens a URI the person did not share.

#### This default permission set includes the following:

- `allow-read-clipboard-images`
- `allow-take-shared-images`
- `allow-register-listener`
- `allow-remove-listener`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`station-media-intake:allow-read-clipboard-images`

</td>
<td>

Enables the read_clipboard_images command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`station-media-intake:deny-read-clipboard-images`

</td>
<td>

Denies the read_clipboard_images command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`station-media-intake:allow-register-listener`

</td>
<td>

Enables the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`station-media-intake:deny-register-listener`

</td>
<td>

Denies the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`station-media-intake:allow-remove-listener`

</td>
<td>

Enables the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`station-media-intake:deny-remove-listener`

</td>
<td>

Denies the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`station-media-intake:allow-take-shared-images`

</td>
<td>

Enables the take_shared_images command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`station-media-intake:deny-take-shared-images`

</td>
<td>

Denies the take_shared_images command without any pre-configured scope.

</td>
</tr>
</table>
