using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class UsbDeviceIdTests
{
    [Fact]
    public void Reads_the_serial_of_a_Zebra_cradle()
    {
        Assert.True(UsbDeviceId.TryParse(@"USB\VID_05E0&PID_1701\S20123456789", out var id));
        Assert.Equal("05E0", id.Vid);
        Assert.Equal("1701", id.Pid);
        Assert.Equal("S20123456789", id.Instance);
        Assert.True(id.IsZebra);
        Assert.True(id.HasSerial);
    }

    [Fact]
    public void Ignores_case_in_vendor_and_product()
    {
        Assert.True(UsbDeviceId.TryParse(@"usb\vid_05e0&pid_1701\abc", out var id));
        Assert.True(id.IsZebra);
        Assert.Equal("abc", id.Instance);
    }

    [Fact]
    public void Knows_a_made_up_instance_is_no_serial()
    {
        Assert.True(UsbDeviceId.TryParse(@"USB\VID_1A86&PID_7523\5&2A1B3C4D&0&2", out var id));
        Assert.False(id.IsZebra);
        Assert.False(id.HasSerial);
    }

    [Fact]
    public void Knows_an_interface_of_a_composite_device()
    {
        Assert.True(UsbDeviceId.TryParse(@"USB\VID_05E0&PID_1701&MI_00\6&1234ABCD&0&0000", out var id));
        Assert.True(id.IsInterface);
        Assert.False(id.HasSerial);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(@"ACPI\PNP0501\0")]
    [InlineData(@"BTHENUM\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\7&1&0&000000000000_00000000")]
    [InlineData(@"USB\VID_05E0&PID_1701")]
    public void Rejects_what_is_not_a_USB_device(string? text)
    {
        Assert.False(UsbDeviceId.TryParse(text, out _));
    }
}
